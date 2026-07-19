const Botkit = require("botkit");
const config = require("./config.js");
const taco = require("./taco.js");
const tacobot = require("./bot.js");
const schedule = require("node-schedule");

const controller = Botkit.slackbot(config.controller);
const bot = controller.spawn({ token: config.token });

tacobot.listens(controller);

bot.startRTM((err) => {
  if (err) {
    console.log(err);
    process.exit(1);
  } else {
    console.log("Ready to taco !");
    taco.init();
  }
});

// Botkit already retries indefinitely on abnormal RTM closes (code 1006)
// internally. If it ever gives up for good, exit so pm2 restarts cleanly
// instead of racing a second manual reconnect against Botkit's own retry.
controller.on("rtm_reconnect_failed", function (_bot, err) {
  console.log("RTM reconnect failed permanently", err);
  process.exit(1);
});

schedule.scheduleJob({ hour: 00, minute: 00 }, () => {
  taco.resetLeft();
});
