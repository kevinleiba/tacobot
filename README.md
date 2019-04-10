# Tacobot 🌮

Tacobot is a slackbot inspired by [Heytaco](https://www.heytaco.chat/).

It lets you reward the people you share your slack with thanks to tacos.

## How does it work ?

- Invite @tacobot in a public channel and make sure you are in this channel
- Just ping any coworker with `@` and add as many 🌮as you want\* in the message ! Tacobot will then take your tacos from your daily stash and give them to the coworker you just mentionned. So a message looks like this: `Thanks @heytaco for creating this concept! :taco: :taco:`. And @heyTaco taco counter will be incremented of 2 more tacos.
  - \*Well... up to 5 per day !

## What can Tacobot do ?

### Help

You can send a direct message to @tacobot and ask for `help`, he will be glad to answer you

### Ranking

You can send a direct message to @tacobot and ask for `score` or `ranking`. Then he will display the names of the 5 most tacoed people in the slack. You can also ask Tacobot directly in a public channel, but be careful... It will ping 5 people !

### Left tacos to give

You can send a direct message to @tacobot and ask for `how many` tacos to give you have `left`.

## Installation

Tacobot is not a published slack app. So you need to configure it manually (and by that I mean to code just a bit) and deploy it to your server (or run it in your machine).

### Slack Installation

#### Create a Slack App

Follow this [link](https://api.slack.com/apps?new_app=1) to create an app on Slack. On the field `App Name` chose `Tacobot` and select your `WorkSpace` according to where you want to install Tacobot.

#### Add features and functionality

Click **Add features and functionality** and select **Bots**. Then click **Add a bot user**. On **Display Name** write **Tacobot** and on **Default username** write **tacobot**. Then validate by clicking **Add Bot User**. A message will appear, select **Authorize**.

**DON'T CLOSE THIS PAGE YET !**

#### Config file

In your code, you need to create a file called `config.js`. Put it in the tacobot root directory.
It looks like this:

```javascript
const debug = process.env.NODE_ENV === "development";
const clientId = "**********.**********";
const clientSecret = "********************************";
const scopes = ["bot"];
const clientSigningSecret = "********************************";
const clientVerificationToken = "**********************";

const token = "****-************-*************-**********************";

const controller = {
  debug,
  clientId,
  clientSecret,
  scopes,
  clientVerificationToken,
  clientSigningSecret
};

module.exports = {
  controller,
  token
};
```

These are the values that can be found in the **App Credentials** section.

```
clientID -> Client ID
clientSecret -> Client Secret
clientVerificationToken -> Verification Token
clientSigningSecret -> Signing Secret (click `show` button)
```

#### token

The `token` value can be found in the **Install App** tab (on the left menu). In the **OAuth Tokens for Your Team** section, find **Bot User OAuth Access Token** value.

**NOW YOU CAN CLOSE THIS PAGE, YOU'RE READY TO LAUNCH THE PROJECT**

## Run project

First you need to install dependencies:

```shell
yarn install
```

Then you can just run

```shell
yarn start
```

The project will be launched with `nodemon` and reload on every changes.

### Tests

For the moment, tests are not up to date and are legacy of quick developing.
PRs are welcome.

### Database

Tacobot was supposed to be a POC and then happened to work quite alright. So the database is actually a `.json` file. It will be generated the first time you launch the project.

### Botkit

Tacobot is powered by [Botkit](https://botkit.ai/) 🚀
