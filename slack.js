const config = require("./config.js");
const http = require("https");

const getAllUsers = () => {
  return new Promise((resolve, reject) => {
    const baseUrl = "https://slack.com/api/users.list";
    const options = [`token=${config.token}`, `limit=100`];
    const url = `${baseUrl}?${options.join("&")}`;
    http.get(url, res => {
      res.setEncoding("utf8");
      let rawData = "";
      res.on("data", chunk => {
        rawData += chunk;
      });
      res.on("end", () => {
        try {
          console.log("finished api");
          const parsedData = JSON.parse(rawData);
          if (parsedData.ok) resolve(parsedData);
          else reject(parsedData);
        } catch (e) {
          reject(e.message);
        }
      });
    });
  });
};

module.exports = {
  getAllUsers
};
