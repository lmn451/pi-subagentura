"use strict";

const net = require("node:net");
const original = {
  connect: net.connect,
  createConnection: net.createConnection,
  socketConnect: net.Socket.prototype.connect,
};
require("./deny-network.cjs");

function allowCore(originalMethod, deniedMethod) {
  return function (...args) {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    const path = typeof options === "string" ? options : options?.path;
    const allowed = process.env.SUBAGENTURA_E2E_CORE_SOCKET;
    const localCore =
      typeof path === "string" && path.startsWith("/") && path === allowed;
    return (localCore ? originalMethod : deniedMethod).apply(this, args);
  };
}

net.connect = allowCore(original.connect, net.connect);
net.createConnection = allowCore(
  original.createConnection,
  net.createConnection,
);
net.Socket.prototype.connect = allowCore(
  original.socketConnect,
  net.Socket.prototype.connect,
);
