const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAccessControl,
  isAuthorizedRequest,
  normalizeAccessCode
} = require("../src/accessControl");

test("normalizes access codes by trimming surrounding whitespace", () => {
  assert.equal(normalizeAccessCode("  class-123  "), "class-123");
  assert.equal(normalizeAccessCode(undefined), "");
});

test("marks access control as optional when no code is configured", () => {
  const accessControl = createAccessControl("");

  assert.equal(accessControl.required, false);
});

test("authorizes requests with the configured classroom access code", () => {
  const request = {
    get(headerName) {
      assert.equal(headerName, "x-classroom-access-code");
      return "class-123";
    }
  };

  assert.equal(isAuthorizedRequest(request, "class-123"), true);
  assert.equal(isAuthorizedRequest(request, "different"), false);
});
