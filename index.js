const Botkit = require("botkit");
const config = require("./config.js");
const taco = require("./taco.js");
const tacobot = require("./bot.js");

const controller = Botkit.slackbot(config.controller);
const bot = controller.spawn({
  token: config.token
});
bot.startRTM((err, bot, payload) => {
  if (err) {
    throw new Error(err);
  } else {
    console.log("Ready to taco !");
    taco.init();
    tacobot.listens(controller);
  }
});
