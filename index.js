const Botkit = require("botkit");
const config = require("./config.js");
const taco = require("./taco.js");

const controller = Botkit.slackbot(config.controller);
const bot = controller.spawn({
  token: config.token
});
bot.startRTM((err, bot, payload) => {
  if (err) {
    console.log("ERROR");
    throw new Error(err);
  } else {
    console.log("Ready to taco !");
    taco.init(controller);

    controller.hears(":taco:", "ambient", (bot, message) => {
      console.log("OK ICI !!!!!!!");
      bot.reply(message, "OUI ?");
    });
  }
});
