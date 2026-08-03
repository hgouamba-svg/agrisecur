// router.js — micro-routeur maison (pas de dépendance type Express)
// Suffisant pour le périmètre V1 ; à remplacer par Express/Fastify si le
// nombre de routes grossit significativement (cf. README, section suite).

const routes = []; // { method, pattern: RegExp, keys: string[], handler }

function toPattern(path) {
  const keys = [];
  const pattern = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg;
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function add(method, path, handler) {
  const { regex, keys } = toPattern(path);
  routes.push({ method, regex, keys, handler });
}

const router = {
  get: (path, handler) => add("GET", path, handler),
  post: (path, handler) => add("POST", path, handler),
};

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      return { handler: r.handler, params };
    }
  }
  return null;
}

module.exports = { router, match };
