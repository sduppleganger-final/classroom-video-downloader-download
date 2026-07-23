function buildDownloadOutputTemplate(date = new Date()) {
  return `%(title)s - ${formatDownloadTimestamp(date)}.%(ext)s`;
}

function formatDownloadTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

function pad2(value) {
  return value.toString().padStart(2, "0");
}

module.exports = {
  buildDownloadOutputTemplate,
  formatDownloadTimestamp
};
