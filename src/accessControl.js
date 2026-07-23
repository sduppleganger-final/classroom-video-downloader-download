const crypto = require("crypto");

const accessHeaderName = "x-classroom-access-code";

function createAccessControl(accessCode) {
  const expectedCode = normalizeAccessCode(accessCode);

  return {
    headerName: accessHeaderName,
    required: Boolean(expectedCode),
    middleware(request, response, next) {
      if (!expectedCode || isAuthorizedRequest(request, expectedCode)) {
        next();
        return;
      }

      response.status(401).json({
        error: "Enter the classroom access code to use this demo."
      });
    }
  };
}

function isAuthorizedRequest(request, expectedCode) {
  const suppliedCode = normalizeAccessCode(request.get(accessHeaderName));

  if (!suppliedCode) {
    return false;
  }

  return timingSafeEqual(suppliedCode, expectedCode);
}

function normalizeAccessCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  accessHeaderName,
  createAccessControl,
  isAuthorizedRequest,
  normalizeAccessCode
};
