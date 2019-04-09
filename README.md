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

### Config file

First of all, to make it work, you need to create a file called `config.js`.
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

#### NODE_ENV

TODO

#### clientId

TODO

#### clientSecret

TODO

#### scopes

TODO

#### clientSigningSecret

TODO

#### clientVerificationToken

TODO

#### token

TODO

### Slack installation

TODO

## Run project

First you need to install dependencies:

```shell
yarn install
```

Then you can just run

```shell
yarn start
```

The project will be lunched with `nodemon` and reload on every changes.

### Tests

For the moment, tests are not up to date and are legacy of quick developing.
PRs are welcome.

### Database

Tacobot was supposed to be a POC and then happened to work quite alright. So the database is actually a `.json` file. It will be generated the first time you lunch the project.

### Botkit

Tacobot is powered by [Botkit](https://botkit.ai/) 🚀
