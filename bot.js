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
      const tacosGiven = parser.countTacos(message.text);
      if (userIndex > -1 && userIndex !== senderIndex) {
        const giver = DB.getUser(senderIndex);
        if (giver.left >= tacosGiven) {
          taco.giveTaco(userIndex, tacosGiven);
          taco.removeLeft(senderIndex, tacosGiven);
          bot.api.reactions.add(
            {
              timestamp: message.ts,
              channel: message.channel,
              name: "taco"
            },
            function(err, res) {
              if (err) {
                bot.botkit.log("Failed to add emoji reaction :(", err);
              }
            }
          );
        } else {
          bot.reply(
            message,
            `Sorry <@${message.user}>, you only have ${
              giver.left
            } tacos remaning.. And you tried to give *${tacosGiven}*`
          );
        }
      }
    }
  });
};

const forScore = controller => {
  controller.hears("score", "direct_mention", (bot, message) => {
    const users = DB.getUsers();
    const ranked = users.sort((a, b) => b.tacos - a.tacos);
    const firsts = ranked.slice(0, 5).filter(u => u.tacos > 0);
    const sentences = firsts.map(
      (user, index) =>
        `<@${user.id}> is n°${index + 1} with *${user.tacos}* tacos`
    );
    bot.reply(message, sentences.join("\n"));
  });
};

const listens = controller => {
  forTaco(controller);
  forScore(controller);
};

module.exports = {
  listens
};
