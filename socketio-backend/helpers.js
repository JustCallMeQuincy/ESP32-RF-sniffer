exports.logMessage = (event, message, connId, data = false) => {
  var timestamp = new Date().toISOString();
  console.log(timestamp + " - " + event + " - " + connId + " - " + message);
  if (data) {
    console.log(data);
  }
};

exports.isJSONStringObject = str => {
  try {
    const parsed = JSON.parse(str);
    return (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch (e) {
    return false;
  }
};