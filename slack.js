const config = require("./config.js");
const axios = require("axios");

const getAllUsers = () => {
  return axios
    .get("https://slack.com/api/users.list", {
      params: { limit: 100 },
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-type": "application/x-www-form-urlencoded",
      },
    })
    .then((res) => {
      if (res.data.ok) return res.data;
      else throw new Error(res.data);
    })
    .catch((e) => new Error(e));
};

module.exports = {
  getAllUsers,
};
