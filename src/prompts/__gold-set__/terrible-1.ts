// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

// @ts-nocheck
// Gold-set fixture: intentionally terrible code for best-practices score ≤ 3.0

export var API_KEY = "sk-proj-1234567890abcdef1234567890abcdef";
export var DB_PASSWORD = "admin123!@#";

export function processData(data) {
  var result = eval("(" + JSON.stringify(data) + ")");
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
  // TODO: add error handling later
  return fetch(url).then(function (r) {
    return r.json();
  });
}

export function validate(x) {
  if (x == undefined || x == null || x == "" || x == 0 || x == false) {
    return false;
  }
  return true;
}

export function helper1(a, b, c, d, e, f) {
  return [a, b, c, d, e, f].map(function (x) {
    return x ? x : "default";
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
  var data = JSON.parse(input);
  var output = [];
  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i];
    if (item.type == "A") {
      output.push({ value: item.value * 2, label: item.name.toUpperCase() });
    } else if (item.type == "B") {
      output.push({ value: item.value * 3, label: item.name.toLowerCase() });
    } else if (item.type == "C") {
      output.push({ value: item.value * 4, label: item.name });
    } else if (item.type == "D") {
      output.push({ value: item.value * 5, label: item.name });
    } else {
      output.push({ value: item.value, label: "unknown" });
    }
  }
  console.log("processed " + output.length + " items");
  return JSON.stringify(output);
}
