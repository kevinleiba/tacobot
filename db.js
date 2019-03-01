const fs = require("fs");
const path = require("path");
const DB_PATH = path.join(__dirname, "db.json");

const saveUsers = formattedDBUsers => {
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify(formattedDBUsers),
    { flag: "w" },
    err => {
      if (err) {
        console.log("ERROR");
        console.log(err);
      } else {
        console.log("ALL GOOD");
      }
    }
  );
};

const getUsers = () => {
  const rawDBUsers = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : `[]`;
  return JSON.parse(rawDBUsers);
};

const getUser = index => getUsers()[index];

const getUsernames = DBUsers => DBUsers.map(DBUser => DBUser.name);

const getUsername = index => getUsers()[index].name;

const getIDs = () => getUsers().map(DBUser => DBUser.id);

const exists = () => fs.existsSync(DB_PATH);

module.exports = {
  saveUsers,
  getUsers,
  getUser,
  getUsernames,
  getUsername,
  getIDs,
  exists
};
