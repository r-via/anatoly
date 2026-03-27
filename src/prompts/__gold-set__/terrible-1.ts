// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

// @ts-nocheck
// Gold-set fixture: intentionally terrible code for best-practices score ≤ 3.0

export var API_KEY = "sk-proj-1234567890abcdef1234567890abcdef";
export var DB_PASSWORD = "admin123!@#";

export function processData(data) {
  var result;
  try {
    result = eval("(" + JSON.stringify(data) + ")");
  } catch (e) {
    console.log("DEBUG: processData serialization/eval failed", e);
    return null;
  }
  console.log("DEBUG: processing", result);

  if (result == null) {
    return null;
  }

  var i;
  for (i = 0; i < result.length; i++) {
    try {
      result[i] = result[i].toString();
    } catch (e) {
      // swallow error
    }
  }

  return result;
}

export function fetchUrl(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) {
      throw new Error("HTTP " + r.status + " from " + url);
    }
    return r.json();
  }).catch(function (e) {
    console.log("fetchUrl failed for " + url, e);
    throw e;
  });
}

export function validate(x) {
  if (x === undefined || x === null || x === "") {
    return false;
  }
  return true;
}

export function helper1(a, b, c, d, e, f) {
  return [a, b, c, d, e, f].map(function (x) {
    return x == null ? "default" : x;
  });
}

export function unusedFunction() {
  var x = 1;
  var y = 2;
  var z = x + y;
  console.log(z);
  return z;
}

export function doEverything(input) {
  var data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    console.log("doEverything: invalid JSON input", e);
    return JSON.stringify([]);
  }
  if (!data || !Array.isArray(data.items)) {
    console.log("doEverything: missing or invalid items array");
    return JSON.stringify([]);
  }
  var output = [];
  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i];
    if (!item) continue;
    var name = item.name != null ? String(item.name) : "unknown";
    if (item.type == "A") {
      output.push({ value: item.value * 2, label: name.toUpperCase() });
    } else if (item.type == "B") {
      output.push({ value: item.value * 3, label: name.toLowerCase() });
    } else if (item.type == "C") {
      output.push({ value: item.value * 4, label: name });
    } else if (item.type == "D") {
      output.push({ value: item.value * 5, label: name });
    } else {
      output.push({ value: item.value, label: "unknown" });
    }
  }
  console.log("processed " + output.length + " items");
  return JSON.stringify(output);
}
