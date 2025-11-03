function onOpen() {
  const factory = 'createMenu';
  for (const key in this) {
    const maybeLib = this[key];
    if (maybeLib && typeof maybeLib[factory] === 'function') {
      maybeLib[factory](key);
      break;
    }
  }
}
