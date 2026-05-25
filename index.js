const Botkit = require("botkit");
const config = require("./config.js");
const taco = require("./taco.js");
const tacobot = require("./bot.js");
const schedule = require("node-schedule");

const controller = Botkit.slackbot(config.controller);

let isConnecting = false;

const startRTM = () => {
  if (isConnecting) return;
  isConnecting = true;
  const bot = controller.spawn({ token: config.token });
  bot.startRTM((err, _bot, _payload) => {
    isConnecting = false;
    if (err) {
      console.log(err);
      return setTimeout(startRTM, 60000);
    } else {
      console.log("Ready to taco !");
      taco.init();
    }
  });
};

controller.on("rtm_close", function (_bot, _err) {
  startRTM();
});

tacobot.listens(controller);
startRTM();

schedule.scheduleJob({ hour: 00, minute: 00 }, () => {
  taco.resetLeft();
});
