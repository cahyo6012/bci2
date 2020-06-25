const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-core')
const cheerio = require('cheerio')
const mysql = require('mysql')
const SQLBuilder = require('json-sql-builder2')
const config = require('./config')

class BCI {
  constructor() {
    this.DOWNLOAD_PATH = config.download_path
    this.PROJECTS_PATH = path.resolve(this.DOWNLOAD_PATH, 'projects')
    this.sql = new SQLBuilder('MySQL')
    this.pool = mysql.createPool(config.mysql_config)
  }
  
  async login(username, password) {
    const url = 'https://www.bciasia.com/login/'

    this.browser = await puppeteer.launch({
      executablePath: config.executablePath,
      devtools: true
    })

    this.page = await this.browser.newPage()
    await this.page.setDefaultTimeout(120000)

    this.page.goto(url, { waitUntil: 'networkidle2' })
    
    await this.page.waitForSelector('#memberLoginTextInput')
    await this.page.type('#memberLoginTextInput', username)
    await this.page.type('#memberLoginPassInput', password)
    await this.page.click('#submit')
    await this.page.waitForNavigation({ waitUntil: 'networkidle2' })

    const { CFID, CFTOKEN } = (await this.page.url()).match(/CFID=(?<CFID>\d+)&CFTOKEN=(?<CFTOKEN>\d+)/).groups
    this.CFID = CFID
    this.CFTOKEN = CFTOKEN
    
    return this
  }

  async logout() {
    await this.page.click('.nav-right > li > a[target="_parent"]')
    await this.page.waitForNavigation({ waitUntil: 'networkidle2' })
    return this
  }

  async genExcel(postData) {
    await this.page.setRequestInterception(true)
    this.page.once('request', req => {
      console.log(req.headers(), req.postData())
      req.continue({ method: 'POST', postData })
    })
    
    const url = `https://services.bciasia.com/View/gen_excel/gen_excel_file.cfm?no_logo=1&no_lm=1&focus=1&CFID=${this.CFID}&CFTOKEN=${this.CFTOKEN}&export_type=projects&bci_own=1`
    const res = await this.page.goto(url)
    await this.page.setRequestInterception(false)
    const buffer = await res.buffer()
    console.log(buffer, buffer.byteLength)
    return false
  }

  async downloadAllProjects() {
    const url = await this.page.$eval('#project-tile-group a', e => e.href)
    await this.page.goto(url, { waitUntil: 'networkidle2' })

    await this.page.waitForSelector('.searchAdvButton')
    await this.page.click('.searchAdvButton')
    await this.page.waitForNavigation({ waitUntil: 'networkidle2' })

    await this.page.waitFor('[name=project_pp]')
    await this.page.select('[name=project_pp]', '500')
    await this.page.waitForNavigation({ waitUntil: 'networkidle2' })

    let hasNext = false
    let i = 1
    do {
      console.log(i)
      hasNext = await this.page.$eval('[name=change_ppp]', e => e.textContent.includes('Next'))

      await this.page.waitForSelector('[name=allbox]')
      await this.page.click('[name=allbox]')
      
      const action = `/View/gen_excel/gen_excel_file.cfm?no_logo=1&no_lm=1&focus=1&CFID=${this.CFID}&CFTOKEN=${this.CFTOKEN}&export_type=projects&bci_own=1`
      const data = await this.page.evaluate(action => {
        const form = document.querySelector('[name=batch]')
        form.target = '_self'

        const data = new FormData(form)
        return fetch(action, {
          method: 'POST',
          credentials: 'include',
          body: data
        })
        .then(res => res.text())
      }, action)

      fs.writeFileSync(path.resolve(this.PROJECTS_PATH, i + '.xls'), data, { encoding: 'ucs2' })

      if (hasNext) {
        await this.page.$$eval('[name=change_ppp] a', es => {
          for (let e of es) {
            if(e.textContent.includes('Next')) return e.click()
          }
        })
        await this.page.waitFor(2500)
      }

      i++
    } while (hasNext)
    return this
  }

  truncateTable(con, tableName) {
    return new Promise(resolve => {
      console.log(`Truncating Table ${tableName}`)
      con.query('TRUNCATE TABLE ??', [tableName], err => {
        if (err) {
          console.log(err.sqlMessage)
        }
        console.log(`Truncate Table ${tableName} Executed`)
        resolve(true)
      })
    })
  }

  loadFromXml(filepath) {
    const sheets = {}
    console.log(`\nLoading File ${filepath}`)
    const xml = fs.readFileSync(filepath, 'utf-8').replace(/\0/g, '')
    const $ = cheerio.load(xml, { xmlMode: true })
    const worksheets = $('Worksheet')
    const sheetNames = []
    
    for (let i = 0; i < worksheets.length; i++) {
      sheetNames.push($(worksheets.get(i)).attr('ss:Name'))
    
      const table = $(worksheets.get(i)).find('Table')
      const rows = $(table).find('Row')
    
      const keys = []
      for (let j = 0; j < $(rows.get(0)).find('Data').length; j++) {
        keys.push($($(rows.get(0)).find('Data').get(j)).text())
      }
    
      const data = []
      for (let j = 1; j < rows.length; j++) {
        const d = {}
        const cells = $(rows.get(j)).find('Data')
        for (let k = 0; k < keys.length; k++) {
          d[keys[k]] = $(cells.get(k)).text()
        }
        data.push(d)
      }
  
      if(!sheets[sheetNames[i]]) sheets[sheetNames[i]] = []
      sheets[sheetNames[i]] = sheets[sheetNames[i]].concat(data)
    }
    
    return sheets
  }

  formatDate(date, timestamp = false) {
    if(timestamp) {
      const [d, m, y, hh, mm, ss] = date.split(/\W/g)
      const newDate = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(hh), parseInt(mm), parseInt(ss))
      return newDate
    } else {
      const [d,m,y] = date.split('/')
      const newDate = new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
      return newDate
    }
  }

  normalizeProjects (projects = [{}]) {
    const dimProjectCategory = require('./dim_project_category.json')[2].data
    const scKeys = Object.keys(projects[0]).filter(v => v.match(/^SUBCAT_\d$/))
    
    const data = []
    const relProjectCategory = []
    for (let p of projects) {
      const project = {
        id: p['PROJECTID'],
        ref_id: p['PROJECT_REFID'],
        version: p['VERSION'],
        type: p['PROJECT_TYPE'],
        name: p['PROJECT_NAME'],
        value: p['VALUE'],
        us_value: p['USVALUE'],
        stage_id: p['PROJECTSTAGEID'],
        status_id: p['PROJECT_STATUSID'],
        const_start: this.formatDate(p['CONST_START']),
        const_end: this.formatDate(p['CONST_END']),
        timestamp: this.formatDate(p['TIME_STAMP']),
        green_building_rating: p['GREEN_BUILDING_RATING'],
        address: p['ADDRESS'],
        post_code: p['POSTCODE'],
        town: p['TOWN'],
        province: p['PROVINCE'],
        bci_region: p['BCIREGION'],
        country: p['COUNTRY_NAME'],
        floor_area: p['FLOOR_AREA'],
        site_area: p['SITE_AREA'],
        storeys: p['STOREYS'],
        units_residential: p['UNITS_RESIDENTIAL'],
        units_industrial: p['UNITS_INDUSTRIAL'],
        units_subdivisions: p['UNITS_SUBDIVISIONS'],
        owner_type_id: p['OWNER_TYPEID'],
        dev_type_id: p['DEV_TYPEID'],
        status_desc: p['STATUS_DESC'],
        remarks_1: p['REMARKS'],
        remarks_2: p['L_REMARKS'],
      }
      data.push(project)
  
      for(let scKey of scKeys) {
        const dpc = dimProjectCategory.find(v => v.sub_category_id == p[scKey]) 
        if(dpc) {
          const rpc = {
            id: '',
            category: dpc.id,
            project: project.id
          }
          relProjectCategory.push(rpc)
        }
      }
    }
    return { project: data, relProjectCategory }
  }

  normalizeCompanyContact(firms = [{}]) {
    const companyIds = []
    const companies = []
    const contactIds = []
    const contacts = []
    const relCompanyContactRole = []
    const relProjectContactCompany = []
  
    for (let f of firms) {
      const company = {
        id: f['FIRMID'],
        name: f['FIRM_NAME'],
        address: f['FIRM_ADDRESS'],
        town: f['FIRM_TOWN'],
        province: f['FIRM_PROVINCE'],
        post_code: f['FIRM_POSTCODE'],
        country: f['FIRM_COUNTRY'],
        website: f['FIRM_WEBSITE'],
      }
      companyIds.push(company.id)
      companies.push(company)
  
      const contact = {
        id: f['CONTACTID'],
        salutation: f['SALUTATION'],
        first_name: f['FIRST_NAME'],
        last_name: f['LAST_NAME'],
        phone: f['CONTACT_PHONE'],
        mobile: f['CONTACT_MOBILE'],
        fax: f['CONTACT_FAX'],
        email: f['CONTACT_EMAIL'],
        position: f['POSITION'],
        company_id: f['FIRMID'],
      }
      contactIds.push(contact.id)
      contacts.push(contact)
  
      const rccr = {
        company: f['FIRMID'],
        contact: f['CONTACTID'],
        role: f['ROLE_ID']
      }
      if(rccr.contact != 1) relCompanyContactRole.push(rccr)
  
      const rpcc = {
        project: f['PROJECTID'],
        contact: f['CONTACTID'],
        company: f['FIRMID'],
      }
      if(rpcc.contact != 1) relProjectContactCompany.push(rpcc)
    }
  
    const uniqueCompanyIds = [...new Set(companyIds)]
    const uniqueContactIds = [...new Set(contactIds)]
  
    const data = {
      company: [],
      contact: [],
      relCompanyContactRole,
      relProjectContactCompany
    }
  
    for (let id of uniqueCompanyIds) data.company.push(companies.find(v => v.id == id))
    for (let id of uniqueContactIds) id != 1 && data.contact.push(contacts.find(v => v.id == id))
  
    return data
  }

  createQuery(project = [], tableName) {
    const projectQuery = this.sql.$insert({
      $table: tableName,
      $documents: project,
    })
    return projectQuery
  }
  
  executeQuery(con, query, queryName) {
    return new Promise(resolve => {
      console.log(`Executing ${queryName} Query`)
      con.query(query.sql.replace('INSERT INTO', 'INSERT IGNORE INTO'), query.values, err => {
        if (err) {
          console.log(err.sqlMessage)
        }
        console.log(`${queryName} Query Executed`)
        resolve(true)
      })
    })
  }

  importProjects() {
    return new Promise(resolve => {
      this.pool.getConnection(async (err, con) => {
        if (err) {
          console.log(err)
          process.exit()
        }
        console.log('Mysql Connected')
    
        let listQuery = [
          { name: 'project', query: null },
          { name: 'company', query: null },
          { name: 'contact', query: null },
          { name: 'rel_project_category', query: null },
          { name: 'rel_company_contact_role', query: null },
          { name: 'rel_project_contact_company', query: null },
        ]
        
        for(let q = 0; q < listQuery.length; q++) await this.truncateTable(con, listQuery[q].name)
    
        const listFile = fs.readdirSync(this.PROJECTS_PATH)
        for (let f of listFile) {
          const data = this.loadFromXml(path.resolve(this.PROJECTS_PATH, f))
          console.log(data['Projects'][0])
          const { project, relProjectCategory } = this.normalizeProjects(data['Projects'])
          const { company, contact, relCompanyContactRole, relProjectContactCompany } = this.normalizeCompanyContact(data['Firm Details'])
          
          listQuery = [
            { name: 'project', query: this.createQuery(project, 'project') },
            { name: 'company', query: this.createQuery(company, 'company') },
            { name: 'contact', query: this.createQuery(contact, 'contact') },
            { name: 'rel_project_category', query: this.createQuery(relProjectCategory, 'rel_project_category') },
            { name: 'rel_company_contact_role', query: this.createQuery(relCompanyContactRole, 'rel_company_contact_role') },
            { name: 'rel_project_contact_company', query: this.createQuery(relProjectContactCompany, 'rel_project_contact_company') },
          ]
      
          for(let q of listQuery) {
            await this.executeQuery(con, q.query, q.name)
          }
        }

        resolve(this)
      })
    })
  }
}

module.exports = BCI