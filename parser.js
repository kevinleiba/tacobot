const { compose, removeStr } = require("./utils.js");

const ID_REGEX = /<@\S*>/;

const parseId = id =>
  compose(
    str => removeStr(str, "<@"),
    str => removeStr(str, ">")
  )(id);

const findID = message => {
  const matching = message.match(ID_REGEX);
  return matching === null ? null : parseId(matching[0]);
};

module.exports = {
  findID
};
