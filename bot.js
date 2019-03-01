const parser = require("./parser.js");
const taco = require("./taco.js");
const DB = require("./db.js");

const forTaco = controller => {
  controller.hears(":taco:", "ambient", (bot, message) => {
    const id = parser.findID(message.text);
    if (id !== null) {
      const ids = DB.getIDs();
      const userIndex = ids.indexOf(id);
      const senderIndex = ids.indexOf(message.user);
      if (userIndex > -1 && userIndex !== senderIndex) {
        taco.giveTaco(userIndex);
        taco.removeLeft(senderIndex);
        const user = DB.getUser(userIndex);
        const giver = DB.getUser(senderIndex);
        bot.reply(
          message,
          `Congratz ! <@${user.id}> now has ${user.tacos} tacos !`
        );
        bot.reply(
          message,
          `<@${message.user}> now has ${giver.left} tacos left... Nice job guys`
        );
      }
    }
  });
};

const listens = controller => {
  forTaco(controller);
};

module.exports = {
  listens
};
