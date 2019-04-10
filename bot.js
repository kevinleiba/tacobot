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
      } else if (userIndex === senderIndex) {
        bot.api.reactions.add(
          {
            timestamp: message.ts,
            channel: message.channel,
            name: "fu"
          },
          function(err, res) {
            if (err) {
              bot.botkit.log("Failed to add emoji reaction :(", err);
            }
          }
        );
      }
    }
  });
};

const forScore = controller => {
  controller.hears(
    ["score", "ranking"],
    ["direct_mention", "direct_message"],
    (bot, message) => {
      const users = DB.getUsers();
      const ranked = users.sort((a, b) => b.tacos - a.tacos);
      const firsts = ranked.slice(0, 5).filter(u => u.tacos > 0);
      const sentences = firsts.map(
        (user, index) =>
          `<@${user.id}> is n°${index + 1} with *${user.tacos}* tacos`
      );
      bot.reply(message, sentences.join("\n"));
    }
  );
};

const forLeft = controller => {
  controller.hears(
    ["left", "combien", "how much", "how many"],
    "direct_message",
    (bot, message) => {
      const ids = DB.getIDs();
      const userIndex = ids.indexOf(message.user);
      const user = DB.getUser(userIndex);
      bot.reply(message, `You have ${user.left} tacos left for today`);
    }
  );
};

const forHelp = controller => {
  controller.hears(
    ["help", "aide", "commandes", "commande"],
    ["direct_message", "direct_mention"],
    (bot, message) => {
      bot.reply(
        message,
        `
     In public channels, just ping someone and add the :taco: emoji next to his name.
You can ask me how many :taco: you have left but in direct message:
Just ask me \`left\` (or \`how many\`; \`how much\`)

If you want to know the ranking, ask me \`score\` or \`ranking\`
    `
      );
    }
  );
};

const listens = controller => {
  forTaco(controller);
  forScore(controller);
  forLeft(controller);
  forHelp(controller);
};

module.exports = {
  listens
};
