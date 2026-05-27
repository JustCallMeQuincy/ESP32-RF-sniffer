exports.logMessage = (event, message, connId, data = false) => {
  const timestamp = new Date().toISOString();
  console.log(timestamp + " - " + event + " - " + connId + " - " + message);
  if (data) {
    console.log(data);
  }
};

exports.isJSONStringObject = input => {
  if (input === null || input === undefined) return false;

  // If it's already an object (not an array), consider it a JSON object
  if (typeof input === "object") {
    return (input !== null && !Array.isArray(input));
  }

  // Otherwise, expect a string and try to parse it
  if (typeof input !== "string") return false;

  try {
    const parsed = JSON.parse(input);
    return (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch (e) {
    return false;
  }
};