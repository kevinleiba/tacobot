const compose = (...fns) => x => fns.reduce((acc, curr) => curr(acc), x);

const removeStr = (str, toFind) => str.replace(toFind, "");

module.exports = {
  compose,
  removeStr
};
