const BCI = require('./lib/BCI')
const { bci_config } = require('./lib/config')

async function main() {
  const bci = new BCI()
  await bci.login(bci_config.username, bci_config.password)
  await bci.downloadAllProjects()
  await bci.importProjects()
  await bci.logout()
}

main()