const fs = require("fs");
const path = require("path");
const DB_PATH = path.join(__dirname, "db.json");

const slack = require("./slack.js");

const populate = () => {
  slack
    .getAllUsers()
    .then(formatUsers)
    .then(writeMembers)
    .then(() => {
      console.log("POPULATED DB!");
    })
    .catch(e => {
      console.log("ERROR WHEN POPULATING DB :(");
      console.log(e);
    });
};

const init = () => {
  const exists = fs.existsSync(DB_PATH);
  if (!exists) return populate();
};

const formatUsers = users => {
  const members = users.members;
  return members.map(member => ({
    id: member.id,
    name: member.name
  }));
};

const updateUser = (DBUser, APIMember) => {
  return { ...DBUser, name: APIMember.name };
};

const getDBUsers = () => {
  const rawDBUsers = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : `[]`;
  return JSON.parse(rawDBUsers);
};

const writeToDb = formattedDBUsers => {
  fs.writeFile(
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

const writeMembers = APIMembers => {
  const DBUsers = getDBUsers();
  const formattedDBUsers = APIMembers.map(APIMember => {
    const DBUser = DBUsers.find(dbu => dbu.id === APIMember.id);
    if (DBUser !== undefined) return updateUser(DBUser, APIMember);
    else return { ...APIMember, tacos: 0, left: 5 };
  });
  writeToDb(formattedDBUsers);
};

const dbToNames = DBUsers => DBUsers.map(DBUser => DBUser.name);

const giveTaco = name => {
  const DBUsers = getDBUsers();
  const index = dbToNames(DBUsers).indexOf(name);
  if (index > -1) {
    const user = DBUsers[index];
    DBUsers[index] = { ...user, tacos: user.tacos + 1 };
    writeToDb(DBUsers);
  } else {
    console.log(`could not find ${name}`);
  }
};

module.exports = {
  init,
  writeMembers,
  giveTaco
};
