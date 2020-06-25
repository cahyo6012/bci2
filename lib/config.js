require('dotenv').config()

module.exports = {
  mysql_config: {
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DB || "camkoha"
  },
  bci_config: {
    username: process.env.BCI_USERNAME,
    password: process.env.BCI_PASSWORD
  },
  download_path: process.env.DOWNLOAD_PATH,
  executablePath: process.env.EXECUTABLE_PATH,
}