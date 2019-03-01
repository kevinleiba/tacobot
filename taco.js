const DB = require("./db.js");
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
  if (!DB.exists()) populate();
};

const formatUsers = users => {
  const members = users.members;
  return members.map(member => ({
    id: member.id,
    name: member.name
  }));
};

const updateUserName = (DBUser, APIMember) => {
  return { ...DBUser, name: APIMember.name };
};

const writeMembers = APIMembers => {
  const DBUsers = DB.getUsers();
  const formattedDBUsers = APIMembers.map(APIMember => {
    const DBUser = DBUsers.find(dbu => dbu.id === APIMember.id);
    if (DBUser !== undefined) return updateUserName(DBUser, APIMember);
    else return { ...APIMember, tacos: 0, left: 5 };
  });
  DB.saveUsers(formattedDBUsers);
};

const giveTaco = name => {
  const DBUsers = DB.getUsers();
  const index = DB.getUsernames(DBUsers).indexOf(name);
  if (index > -1) {
    const user = DBUsers[index];
    DBUsers[index] = { ...user, tacos: user.tacos + 1 };
    DB.saveUsers(DBUsers);
  } else {
    console.log(`could not find ${name}`);
  }
};

module.exports = {
  init,
  writeMembers,
  giveTaco
};
