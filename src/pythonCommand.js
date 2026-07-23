function getPythonCommand() {
  return process.env.PYTHON_BIN || process.env.PYTHON || "python";
}

module.exports = {
  getPythonCommand
};
