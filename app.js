/**
 * Gastos operativos compartidos (Luis / Jefe) vía GitHub Contents API.
 * Sin backend. Datos remotos en gastos.json. Token solo en el navegador si el usuario lo guarda.
 * Cada escritura: GET fresco + sha + PUT. Un 409/422 de sha no se reintenta ni sobrescribe.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.GastosApp = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DATA_VERSION = 1;
  var CONFIG_KEY = "gastos-app-config-v1";
  var TOKEN_KEY = "gastos-app-token-v1";
  var DEFAULTS = {
    owner: "Lbbernardo",
    repo: "gastos-app",
    path: "gastos.json",
    branch: "main",
  };
  var CATEGORIAS = [
    "Operativo",
    "Marketing",
    "Software",
    "Transporte",
    "Oficina",
    "Servicios",
    "Otros",
  ];
  var MAX_DESC = 200;
  var MAX_CAT = 40;

  /* ---------- utilidades de monto (centavos enteros) ---------- */

  function toCents(input) {
    var s;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("Monto inválido.");
      s = String(input);
      if (/[eE]/.test(s)) {
        throw new Error("Usa un monto positivo con hasta 2 decimales (ej. 12.50).");
      }
    } else if (typeof input === "string") {
      s = normalizeAmountString(input);
    } else {
      throw new Error("Monto inválido.");
    }
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      throw new Error("Usa un monto como 12,50 o 1.500,00.");
    }
    var parts = s.split(".");
    var dollarStr = parts[0].replace(/^0+(?=\d)/, "");
    if (dollarStr.length > 9) throw new Error("El monto excede el máximo permitido.");
    var dollars = parseInt(dollarStr, 10);
    var cents = parts[1] ? parseInt(parts[1].padEnd(2, "0"), 10) : 0;
    if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(cents)) {
      throw new Error("Monto inválido.");
    }
    var total = dollars * 100 + cents;
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new Error(
        total <= 0 ? "El monto debe ser mayor que 0." : "El monto excede el máximo permitido."
      );
    }
    return total;
  }

  function normalizeAmountString(raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/\s+/g, "");
    if (s.charAt(0) === "$") s = s.slice(1);
    if (!s) throw new Error("Usa un monto como 12,50 o 1.500,00.");
    var hasComma = s.indexOf(",") >= 0;
    var hasDot = s.indexOf(".") >= 0;
    if (hasComma && hasDot) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        if (!/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) {
          throw new Error("Usa un monto como 12,50 o 1.500,00.");
        }
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        if (!/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) {
          throw new Error("Usa un monto como 12,50 o 1.500,00.");
        }
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
      else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
      else throw new Error("Usa un monto como 12,50 o 1.500,00.");
    } else if (hasDot) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
      else if (!/^\d+\.\d{1,2}$/.test(s)) throw new Error("Usa un monto como 12,50 o 1.500,00.");
    } else if (!/^\d+$/.test(s)) {
      throw new Error("Usa un monto como 12,50 o 1.500,00.");
    }
    return s;
  }

  function parseDollarsToCents(str) {
    return toCents(String(str));
  }

  function formatUSD(cents) {
    if (!Number.isInteger(cents)) cents = Math.round(Number(cents));
    if (!Number.isFinite(cents)) cents = 0;
    var neg = cents < 0;
    var n = Math.abs(cents);
    var d = Math.floor(n / 100);
    var c = String(n % 100).padStart(2, "0");
    var grouped = String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + "$" + grouped + "." + c;
  }

  function isValidISODate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return (
      dt.getUTCFullYear() === p[0] &&
      dt.getUTCMonth() === p[1] - 1 &&
      dt.getUTCDate() === p[2]
    );
  }

  function todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function emptyData() {
    return { version: DATA_VERSION, gastos: [], pagos: [] };
  }

  function assertPlainObject(v, label) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(label + " inválido.");
    }
  }

  function addSafe(a, b) {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      throw new Error("Monto fuera de rango.");
    }
    var s = a + b;
    if (!Number.isSafeInteger(s)) throw new Error("Monto fuera de rango.");
    return s;
  }

  function redactSecrets(text) {
    return String(text || "")
      .replace(/github_pat_[A-Za-z0-9_]+/g, "[token]")
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g, "[token]")
      .replace(/Bearer\s+\S+/gi, "Bearer [token]");
  }

  function looksLikeSecret(s) {
    return (
      /github_pat_[A-Za-z0-9_]+/.test(s) ||
      /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/.test(s) ||
      /Bearer\s+\S+/i.test(s)
    );
  }

  function requireText(value, max, emptyMsg) {
    var t = String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) throw new Error(emptyMsg);
    if (t.length > max) throw new Error("Texto demasiado largo (máximo " + max + " caracteres).");
    if (looksLikeSecret(t)) throw new Error("No pegues un token en los datos.");
    return t;
  }

  function assertId(id, label) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(id)) {
      throw new Error(label + " inválido.");
    }
  }

  function validateData(data) {
    assertPlainObject(data, "Datos");
    if (data.version !== DATA_VERSION) {
      throw new Error("Versión de datos no soportada (esperado " + DATA_VERSION + ").");
    }
    if (!Array.isArray(data.gastos) || !Array.isArray(data.pagos)) {
      throw new Error("Esquema inválido: faltan arreglos gastos/pagos.");
    }
    var gastoIds = {};
    var totalGastos = 0;
    for (var i = 0; i < data.gastos.length; i++) {
      var g = data.gastos[i];
      assertPlainObject(g, "Gasto");
      assertId(g.id, "Id de gasto");
      if (gastoIds[g.id]) throw new Error("Id de gasto duplicado.");
      gastoIds[g.id] = g;
      if (!isValidISODate(g.fecha)) throw new Error("Fecha de gasto inválida.");
      if (typeof g.descripcion !== "string" || !g.descripcion.trim()) {
        throw new Error("Descripción de gasto requerida.");
      }
      if (g.descripcion.length > MAX_DESC || /[\u0000-\u001F\u007F]/.test(g.descripcion)) {
        throw new Error("Descripción de gasto inválida.");
      }
      if (looksLikeSecret(g.descripcion)) throw new Error("No pegues un token en los datos.");
      if (typeof g.categoria !== "string" || !g.categoria.trim()) {
        throw new Error("Categoría de gasto requerida.");
      }
      if (g.categoria.length > MAX_CAT || /[\u0000-\u001F\u007F]/.test(g.categoria)) {
        throw new Error("Categoría de gasto inválida.");
      }
      if (looksLikeSecret(g.categoria)) throw new Error("No pegues un token en los datos.");
      if (!Number.isSafeInteger(g.montoCents) || g.montoCents <= 0) {
        throw new Error("Monto de gasto inválido.");
      }
      totalGastos = addSafe(totalGastos, g.montoCents);
    }
    var pagoIds = {};
    var paidBy = {};
    var totalPagos = 0;
    for (var j = 0; j < data.pagos.length; j++) {
      var p = data.pagos[j];
      assertPlainObject(p, "Pago");
      assertId(p.id, "Id de pago");
      if (pagoIds[p.id]) throw new Error("Id de pago duplicado.");
      pagoIds[p.id] = true;
      if (!isValidISODate(p.fecha)) throw new Error("Fecha de pago inválida.");
      if (!Number.isSafeInteger(p.montoCents) || p.montoCents <= 0) {
        throw new Error("Monto de pago inválido.");
      }
      if (typeof p.gastoId !== "string" || !gastoIds[p.gastoId]) {
        throw new Error("Pago referencia un gasto inexistente.");
      }
      paidBy[p.gastoId] = addSafe(paidBy[p.gastoId] || 0, p.montoCents);
      if (paidBy[p.gastoId] > gastoIds[p.gastoId].montoCents) {
        throw new Error("Los pagos superan el monto del gasto.");
      }
      totalPagos = addSafe(totalPagos, p.montoCents);
    }
    if (totalPagos > totalGastos) throw new Error("Los pagos superan el total de gastos.");
    return data;
  }

  function paidCentsFor(data, gastoId) {
    var sum = 0;
    for (var i = 0; i < data.pagos.length; i++) {
      if (data.pagos[i].gastoId === gastoId) sum = addSafe(sum, data.pagos[i].montoCents);
    }
    return sum;
  }

  function estadoGasto(data, gasto) {
    var paid = paidCentsFor(data, gasto.id);
    if (paid <= 0) return "pendiente";
    if (paid >= gasto.montoCents) return "pagado";
    return "parcial";
  }

  function resumen(data) {
    var totalGastos = 0;
    var totalPagos = 0;
    for (var i = 0; i < data.gastos.length; i++) {
      totalGastos = addSafe(totalGastos, data.gastos[i].montoCents);
    }
    for (var j = 0; j < data.pagos.length; j++) {
      totalPagos = addSafe(totalPagos, data.pagos[j].montoCents);
    }
    return {
      totalGastos: totalGastos,
      totalPagos: totalPagos,
      saldoPendiente: totalGastos - totalPagos,
    };
  }

  function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function montoDesdeCampos(fields) {
    if (fields && Number.isSafeInteger(fields.montoCents)) return fields.montoCents;
    return parseDollarsToCents(fields ? fields.monto : undefined);
  }

  function addGasto(data, fields) {
    validateData(data);
    var next = cloneData(data);
    var montoCents = montoDesdeCampos(fields);
    if (!Number.isSafeInteger(montoCents) || montoCents <= 0) {
      throw new Error("Monto de gasto inválido.");
    }
    if (!isValidISODate(fields.fecha)) throw new Error("Fecha de gasto inválida.");
    var desc = requireText(fields.descripcion, MAX_DESC, "La descripción es obligatoria.");
    var cat = requireText(fields.categoria, MAX_CAT, "La categoría es obligatoria.");
    next.gastos.push({
      id: fields.id ? String(fields.id) : newId(),
      fecha: fields.fecha,
      descripcion: desc,
      categoria: cat,
      montoCents: montoCents,
    });
    return validateData(next);
  }

  function addPago(data, fields) {
    validateData(data);
    var next = cloneData(data);
    var gastoId = String((fields && fields.gastoId) || "").trim();
    if (!gastoId) throw new Error("Debes referenciar el gasto que cubre el pago.");
    var gasto = null;
    for (var i = 0; i < next.gastos.length; i++) {
      if (next.gastos[i].id === gastoId) {
        gasto = next.gastos[i];
        break;
      }
    }
    if (!gasto) throw new Error("El gasto referenciado no existe.");
    if (!isValidISODate(fields.fecha)) throw new Error("Fecha de pago inválida.");
    var montoCents = montoDesdeCampos(fields);
    if (!Number.isSafeInteger(montoCents) || montoCents <= 0) {
      throw new Error("Monto de pago inválido.");
    }
    var ya = paidCentsFor(next, gastoId);
    var restante = gasto.montoCents - ya;
    if (restante <= 0) throw new Error("Este gasto ya está pagado por completo.");
    if (montoCents > restante) {
      throw new Error("No se puede sobrepagar. Restante: " + formatUSD(restante) + ".");
    }
    next.pagos.push({
      id: fields.id ? String(fields.id) : newId(),
      fecha: fields.fecha,
      montoCents: montoCents,
      gastoId: gastoId,
    });
    return validateData(next);
  }

  function deleteGasto(data, gastoId, opts) {
    validateData(data);
    opts = opts || {};
    var next = cloneData(data);
    var idx = -1;
    for (var i = 0; i < next.gastos.length; i++) {
      if (next.gastos[i].id === gastoId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) throw new Error("Gasto no encontrado.");
    var hasPagos = next.pagos.some(function (p) {
      return p.gastoId === gastoId;
    });
    if (hasPagos && !opts.force) {
      throw new Error(
        "No se puede borrar un gasto con pagos asociados. Elimina primero los pagos o confirma el borrado forzado."
      );
    }
    next.gastos.splice(idx, 1);
    if (opts.force) {
      next.pagos = next.pagos.filter(function (p) {
        return p.gastoId !== gastoId;
      });
    }
    return validateData(next);
  }

  function deletePago(data, pagoId) {
    validateData(data);
    var next = cloneData(data);
    var idx = -1;
    for (var i = 0; i < next.pagos.length; i++) {
      if (next.pagos[i].id === pagoId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) throw new Error("Pago no encontrado.");
    next.pagos.splice(idx, 1);
    return validateData(next);
  }

  /* ---------- GitHub Contents API ---------- */

  function b64EncodeUtf8(str) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(str, "utf8").toString("base64");
    }
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64DecodeUtf8(b64) {
    var clean = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
    if (!clean) throw new Error("Contenido remoto vacío o ilegible.");
    if (typeof Buffer !== "undefined") {
      return Buffer.from(clean, "base64").toString("utf8");
    }
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function parseJsonSafe(text) {
    return JSON.parse(text, function (key, value) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
      return value;
    });
  }

  function normalizeToken(raw) {
    var t = String(raw || "").trim();
    t = t.replace(/^(bearer|token)\s+/i, "").trim();
    return t;
  }

  function assertToken(raw) {
    var t = normalizeToken(raw);
    if (!t) {
      var missing = new Error("Ingresa un token fine-grained con acceso Contents al repo.");
      missing.code = "AUTH";
      throw missing;
    }
    if (/[\s\u0000-\u001F\u007F]/.test(t)) {
      var bad = new Error("El token no puede contener espacios ni saltos de línea.");
      bad.code = "AUTH";
      throw bad;
    }
    if (t.length < 40 || t.length > 500 || !/^github_pat_[A-Za-z0-9_]+$/.test(t)) {
      var fmt = new Error(
        "Usa un token fine-grained (github_pat_…) con Contents: Read and write solo de este repo."
      );
      fmt.code = "AUTH";
      throw fmt;
    }
    return t;
  }

  function assertCfg(cfg) {
    assertPlainObject(cfg, "Configuración");
    var owner = String(cfg.owner || "").trim();
    var repo = String(cfg.repo || "").trim();
    var path = String(cfg.path || "").trim();
    var branch = String(cfg.branch || "").trim();
    if (
      looksLikeSecret(owner) ||
      looksLikeSecret(repo) ||
      looksLikeSecret(path) ||
      looksLikeSecret(branch)
    ) {
      throw new Error("La configuración no puede contener un token.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) {
      throw new Error("Owner inválido.");
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new Error("Repositorio inválido.");
    }
    if (
      !path ||
      path.length > 200 ||
      path.charAt(0) === "/" ||
      path.indexOf("\\") >= 0 ||
      path.split("/").some(function (seg) {
        return !seg || seg === "." || seg === ".." || !/^[A-Za-z0-9._-]+$/.test(seg);
      })
    ) {
      throw new Error("Ruta de archivo inválida.");
    }
    if (
      !branch ||
      branch.length > 200 ||
      branch.charAt(0) === "/" ||
      branch.charAt(0) === "-" ||
      branch.indexOf("..") >= 0 ||
      !branch.split("/").every(function (seg) {
        return seg && /^[A-Za-z0-9._-]+$/.test(seg);
      })
    ) {
      throw new Error("Rama inválida.");
    }
    return { owner: owner, repo: repo, path: path, branch: branch };
  }

  function isGitSha(s) {
    return typeof s === "string" && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(s);
  }

  function githubHeaders(token) {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer " + token,
    };
  }

  function githubInit(token, extra) {
    extra = extra || {};
    var init = {
      method: extra.method || "GET",
      headers: Object.assign({}, githubHeaders(token), extra.headers || {}),
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    };
    if (extra.body != null) init.body = extra.body;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(30000);
    }
    return init;
  }

  function safeCommitMessage(message) {
    var m = redactSecrets(String(message || "Actualizar gastos.json"))
      .replace(/[\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!m) m = "Actualizar gastos.json";
    if (m.length > 200) m = m.slice(0, 200);
    return m;
  }

  async function readErrorMessage(res) {
    try {
      var t = await res.text();
      if (!t) return "";
      if (t.length > 4000) t = t.slice(0, 4000);
      var j = JSON.parse(t);
      var m = j && typeof j.message === "string" ? j.message : "";
      m = m.replace(/\s+/g, " ").trim();
      if (m.length > 300) m = m.slice(0, 300);
      return redactSecrets(m);
    } catch (e) {
      return "";
    }
  }

  function isShaConflict(status, msg) {
    if (status === 409) return true;
    if (status !== 422) return false;
    return /sha|conflict|does not match|already exists|mismatch/i.test(msg || "");
  }

  async function request(fetchFn, url, init) {
    if (String(url).indexOf("api.github.com") === -1) {
      throw new Error("Solo se permite contactar api.github.com.");
    }
    if (/token=|access_token=|github_pat_|ghp_/i.test(String(url))) {
      throw new Error("La URL de la API no puede incluir el token.");
    }
    try {
      return await fetchFn(url, init);
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
        var timeout = new Error("Tiempo de espera agotado al contactar GitHub.");
        timeout.code = "TIMEOUT";
        throw timeout;
      }
      var net = new Error("No se pudo contactar GitHub.");
      net.code = "NETWORK";
      throw net;
    }
  }

  /**
   * fetchImpl inyectable para pruebas.
   */
  function createGithubClient(fetchImpl) {
    var fetchFn = fetchImpl || fetch;

    function repoUrl(cfg) {
      return (
        "https://api.github.com/repos/" +
        encodeURIComponent(cfg.owner) +
        "/" +
        encodeURIComponent(cfg.repo)
      );
    }

    function contentsUrl(cfg, withRef) {
      var url =
        repoUrl(cfg) +
        "/contents/" +
        cfg.path
          .split("/")
          .map(function (seg) {
            return encodeURIComponent(seg);
          })
          .join("/");
      if (withRef) url += "?ref=" + encodeURIComponent(cfg.branch);
      return url;
    }

    async function checkRepoAccess(cfg, token) {
      cfg = assertCfg(cfg);
      token = assertToken(token);
      var res = await request(fetchFn, repoUrl(cfg), githubInit(token));
      if (res.status === 401 || res.status === 403) {
        var errAuth = new Error(
          "No autorizado. Revisa el token (fine-grained Contents: Read and write) y que tengas acceso al repo."
        );
        errAuth.code = "AUTH";
        errAuth.status = res.status;
        throw errAuth;
      }
      if (res.status === 404) {
        var err404 = new Error(
          "No se encuentra el repositorio o no tienes acceso (GitHub responde 404 en ambos casos). Confirma owner/repo y permisos del token."
        );
        err404.code = "REPO_ACCESS";
        err404.status = 404;
        throw err404;
      }
      if (!res.ok) {
        var err = new Error("Error al verificar el repositorio (HTTP " + res.status + ").");
        err.code = "HTTP";
        err.status = res.status;
        throw err;
      }
      return true;
    }

    async function getFile(cfg, token) {
      cfg = assertCfg(cfg);
      token = assertToken(token);
      await checkRepoAccess(cfg, token);
      var res = await request(fetchFn, contentsUrl(cfg, true), githubInit(token));
      if (res.status === 404) {
        var missingMsg = await readErrorMessage(res);
        if (/no commit found|not a valid ref|branch does not/i.test(missingMsg)) {
          var errRef = new Error("No se encontró la rama indicada en el repositorio.");
          errRef.code = "HTTP";
          errRef.status = 404;
          throw errRef;
        }
        return { missing: true, sha: null, data: emptyData() };
      }
      if (res.status === 401 || res.status === 403) {
        var errAuth = new Error("No autorizado al leer el archivo de datos.");
        errAuth.code = "AUTH";
        errAuth.status = res.status;
        throw errAuth;
      }
      if (!res.ok) {
        var err = new Error("No se pudo leer gastos.json (HTTP " + res.status + ").");
        err.code = "HTTP";
        err.status = res.status;
        throw err;
      }
      var body = await res.json();
      if (body && body.truncated) {
        throw new Error("gastos.json es demasiado grande para la Contents API. No se leyó un archivo a medias.");
      }
      if (!body || typeof body.content !== "string" || (body.encoding && body.encoding !== "base64")) {
        throw new Error("Respuesta de Contents inválida.");
      }
      if (!isGitSha(body.sha)) {
        throw new Error("SHA remoto ausente; no se usa el archivo para no arriesgar una escritura a ciegas.");
      }
      var text = b64DecodeUtf8(body.content);
      var parsed;
      try {
        parsed = parseJsonSafe(text);
      } catch (e) {
        throw new Error("gastos.json no es JSON válido.");
      }
      validateData(parsed);
      return { missing: false, sha: body.sha, data: parsed };
    }

    /**
     * PUT con sha. Si expectedSha es null/vacío, crea archivo (sin sha).
     * Ante conflicto de sha no reintenta.
     */
    async function putFile(cfg, token, data, expectedSha, message) {
      cfg = assertCfg(cfg);
      token = assertToken(token);
      validateData(data);
      var payload = {
        message: safeCommitMessage(message),
        content: b64EncodeUtf8(JSON.stringify(data, null, 2) + "\n"),
        branch: cfg.branch,
      };
      if (expectedSha != null && expectedSha !== "") {
        if (!isGitSha(expectedSha)) {
          throw new Error("SHA remoto inválido; no se escribe para no sobrescribir.");
        }
        payload.sha = expectedSha;
      }
      var res = await request(
        fetchFn,
        contentsUrl(cfg, false),
        githubInit(token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
      if (!res.ok) {
        var apiMsg = await readErrorMessage(res);
        if (res.status === 409 || isShaConflict(res.status, apiMsg)) {
          var conflict = new Error(
            "Conflicto: el archivo cambió en el remoto (otro usuario pudo guardar). Recarga los datos y vuelve a intentar. No se sobrescribió nada."
          );
          conflict.code = "CONFLICT";
          conflict.status = res.status;
          throw conflict;
        }
        if (res.status === 401 || res.status === 403) {
          var errAuth = new Error(
            "No autorizado para escribir. Revisa el token Contents: Read and write."
          );
          errAuth.code = "AUTH";
          errAuth.status = res.status;
          throw errAuth;
        }
        if (res.status === 404) {
          var err404 = new Error(
            /branch|ref|commit/i.test(apiMsg)
              ? "No se encontró la rama indicada. No se escribió nada."
              : "No se encontró el recurso al guardar. No se escribió nada."
          );
          err404.code = "HTTP";
          err404.status = 404;
          throw err404;
        }
        var err = new Error(
          redactSecrets(apiMsg) || "No se pudo guardar (HTTP " + res.status + ")."
        );
        err.code = "HTTP";
        err.status = res.status;
        throw err;
      }
      var body = {};
      try {
        body = await res.json();
      } catch (e) {
        body = {};
      }
      var sha = body && body.content && body.content.sha;
      return { sha: isGitSha(sha) ? sha : null, data: data };
    }

    /**
     * Relee SHA+datos, aplica mutator(data) -> newData, valida y PUT.
     * Si el archivo faltaba, crea. Si hay conflicto, propaga sin retry ciego.
     */
    async function mutate(cfg, token, mutator, message) {
      cfg = assertCfg(cfg);
      token = assertToken(token);
      if (typeof mutator !== "function") throw new Error("Mutación inválida.");
      var current = await getFile(cfg, token);
      if (!current.missing && !isGitSha(current.sha)) {
        throw new Error("SHA remoto ausente; no se escribe para no sobrescribir.");
      }
      var before = cloneData(current.data);
      var after = mutator(cloneData(current.data));
      validateData(after);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { sha: current.sha, data: after, skipped: true };
      }
      return putFile(cfg, token, after, current.missing ? null : current.sha, message);
    }

    return {
      checkRepoAccess: checkRepoAccess,
      getFile: getFile,
      putFile: putFile,
      mutate: mutate,
    };
  }

  /* ---------- config / token localStorage (solo pedido explícito) ---------- */

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      var parsed = parseJsonSafe(raw);
      return {
        owner: String(parsed.owner || DEFAULTS.owner).trim() || DEFAULTS.owner,
        repo: String(parsed.repo || DEFAULTS.repo).trim() || DEFAULTS.repo,
        path: String(parsed.path || DEFAULTS.path).trim() || DEFAULTS.path,
        branch: String(parsed.branch || DEFAULTS.branch).trim() || DEFAULTS.branch,
      };
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveConfig(cfg) {
    var clean = assertCfg(cfg);
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        owner: clean.owner,
        repo: clean.repo,
        path: clean.path,
        branch: clean.branch,
      })
    );
  }

  function loadSavedToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function saveToken(token) {
    localStorage.setItem(TOKEN_KEY, assertToken(token));
  }

  function forgetToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  /* ---------- UI (solo en navegador) ---------- */

  function text(el, value) {
    el.textContent = value == null ? "" : String(value);
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function stripSecretsFromLocation() {
    try {
      var u = new URL(window.location.href);
      var remove = [];
      u.searchParams.forEach(function (value, key) {
        if (
          /token|pat|secret|passwd|password|authorization|key/i.test(key) ||
          looksLikeSecret(value) ||
          looksLikeSecret(key)
        ) {
          remove.push(key);
        }
      });
      remove.forEach(function (k) {
        u.searchParams.delete(k);
      });
      var hash = u.hash || "";
      var badHash = !!(hash && (looksLikeSecret(hash) || /token|access_token|github_pat_|ghp_/i.test(hash)));
      if (badHash) u.hash = "";
      if (remove.length || badHash) {
        window.history.replaceState(null, "", u.pathname + (u.search || "") + (u.hash || ""));
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function initUI() {
    if (typeof document === "undefined") return;

    var state = {
      cfg: loadConfig(),
      token: "",
      data: emptyData(),
      sha: null,
      missing: true,
      loaded: false,
      busy: false,
      filterEstado: "todos",
      filterCategoria: "todas",
    };

    var savedTok = loadSavedToken();
    if (savedTok) state.token = savedTok;

    var $ = function (id) {
      return document.getElementById(id);
    };

    function setStatus(msg, kind) {
      var box = $("status-msg");
      box.className = "status " + (kind || "info");
      text(box, redactSecrets(msg || ""));
      box.hidden = !msg;
    }

    function reveal(node) {
      if (!node || node.hidden) return;
      try {
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch (e) {
        /* el navegador igual muestra el texto */
      }
    }

    function setFormError(formId, msg, kind) {
      var box = $(formId + "-error");
      if (!box) return;
      text(box, redactSecrets(msg || ""));
      box.hidden = !msg;
      box.className = "form-error" + (kind === "ok" ? " ok" : "");
      if (msg) reveal(box);
    }

    function failForm(formId, message) {
      var msg = redactSecrets(message || "No se pudo guardar.");
      if (msg.indexOf("No se guardó") !== 0) msg = "No se guardó nada en GitHub. " + msg;
      setStatus(msg, "error");
      if (formId) setFormError(formId, msg, "error");
      else reveal($("status-msg"));
    }

    function readTokenFromInput() {
      var raw = ($("cfg-token").value || "").trim();
      if (!raw) return "";
      return assertToken(raw);
    }

    function syncConfigFromForm() {
      state.cfg = {
        owner: ($("cfg-owner").value || "").trim() || DEFAULTS.owner,
        repo: ($("cfg-repo").value || "").trim() || DEFAULTS.repo,
        path: ($("cfg-path").value || "").trim() || DEFAULTS.path,
        branch: ($("cfg-branch").value || "").trim() || DEFAULTS.branch,
      };
    }

    function fillConfigForm() {
      $("cfg-owner").value = state.cfg.owner;
      $("cfg-repo").value = state.cfg.repo;
      $("cfg-path").value = state.cfg.path;
      $("cfg-branch").value = state.cfg.branch;
      if (state.token) {
        $("cfg-token").value = state.token;
        $("token-saved-hint").hidden = !loadSavedToken();
      }
    }

    function renderResumen() {
      var r = resumen(state.data);
      text($("total-gastos"), formatUSD(r.totalGastos));
      text($("total-pagos"), formatUSD(r.totalPagos));
      text($("saldo-pendiente"), formatUSD(r.saldoPendiente));
    }

    function gastoLabel(g) {
      return (
        g.fecha +
        " · " +
        g.categoria +
        " · " +
        g.descripcion +
        " (" +
        formatUSD(g.montoCents) +
        ")"
      );
    }

    function fillPagoSelect() {
      var sel = $("pago-gasto");
      var prev = sel.value;
      clearChildren(sel);
      sel.appendChild(el("option", { value: "", text: "— Selecciona un gasto —" }));
      state.data.gastos.forEach(function (g) {
        var st = estadoGasto(state.data, g);
        if (st === "pagado") return;
        var paid = paidCentsFor(state.data, g.id);
        var rest = g.montoCents - paid;
        sel.appendChild(
          el("option", {
            value: g.id,
            text:
              gastoLabel(g) +
              " · resta " +
              formatUSD(rest) +
              (st === "parcial" ? " (parcial)" : ""),
          })
        );
      });
      if (prev) sel.value = prev;
    }

    function renderGastos() {
      var tbody = $("gastos-tbody");
      clearChildren(tbody);
      var rows = state.data.gastos.slice().sort(function (a, b) {
        return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0;
      });
      var shown = 0;
      rows.forEach(function (g) {
        var st = estadoGasto(state.data, g);
        if (state.filterEstado !== "todos" && st !== state.filterEstado) return;
        if (state.filterCategoria !== "todas" && g.categoria !== state.filterCategoria) return;
        shown += 1;
        var paid = paidCentsFor(state.data, g.id);
        var btn = el("button", {
          type: "button",
          className: "btn btn-danger btn-sm",
          text: "Borrar",
        });
        btn.addEventListener("click", function () {
          onDeleteGasto(g.id);
        });
        tbody.appendChild(
          el("tr", {}, [
            el("td", { text: g.fecha }),
            el("td", { text: g.categoria }),
            el("td", { text: g.descripcion }),
            el("td", { className: "num", text: formatUSD(g.montoCents) }),
            el("td", { className: "num", text: formatUSD(paid) }),
            el("td", {}, [
              el("span", {
                className: "badge badge-" + st,
                text: st === "pendiente" ? "Pendiente" : st === "parcial" ? "Parcial" : "Pagado",
              }),
            ]),
            el("td", {}, [btn]),
          ])
        );
      });
      if (!shown) {
        tbody.appendChild(
          el("tr", {}, [
            el("td", {
              colspan: "7",
              className: "empty",
              text: state.loaded
                ? "No hay gastos con estos filtros."
                : "Carga los datos remotos para comenzar.",
            }),
          ])
        );
      }
    }

    function renderPagos() {
      var tbody = $("pagos-tbody");
      clearChildren(tbody);
      var byId = {};
      state.data.gastos.forEach(function (g) {
        byId[g.id] = g;
      });
      var rows = state.data.pagos.slice().sort(function (a, b) {
        return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0;
      });
      rows.forEach(function (p) {
        var g = byId[p.gastoId];
        var ref = g ? g.fecha + " · " + g.descripcion : "(gasto eliminado)";
        var btn = el("button", {
          type: "button",
          className: "btn btn-danger btn-sm",
          text: "Borrar",
        });
        btn.addEventListener("click", function () {
          onDeletePago(p.id);
        });
        tbody.appendChild(
          el("tr", {}, [
            el("td", { text: p.fecha }),
            el("td", { className: "num", text: formatUSD(p.montoCents) }),
            el("td", { text: ref }),
            el("td", {}, [btn]),
          ])
        );
      });
      if (!tbody.firstChild) {
        tbody.appendChild(
          el("tr", {}, [
            el("td", {
              colspan: "4",
              className: "empty",
              text: state.loaded ? "Sin pagos aún." : "Carga los datos remotos para comenzar.",
            }),
          ])
        );
      }
    }

    function refreshAll() {
      renderResumen();
      fillPagoSelect();
      renderGastos();
      renderPagos();
    }

    function client() {
      return createGithubClient();
    }

    function withBusy(fn) {
      return async function () {
        if (state.busy) return;
        state.busy = true;
        document.body.classList.add("busy");
        try {
          await fn();
        } finally {
          state.busy = false;
          document.body.classList.remove("busy");
        }
      };
    }

    var onLoad = withBusy(async function () {
      syncConfigFromForm();
      var token = "";
      try {
        assertCfg(state.cfg);
        token = readTokenFromInput();
      } catch (e) {
        setStatus(e.message || "Configuración o token inválido.", "error");
        return;
      }
      if (!token) {
        setStatus("Ingresa un token fine-grained con acceso Contents al repo.", "error");
        reveal($("status-msg"));
        return;
      }
      setStatus("Cargando datos remotos…", "info");
      try {
        var result = await client().getFile(state.cfg, token);
        state.data = result.data;
        state.sha = result.sha;
        state.missing = result.missing;
        state.loaded = true;
        state.token = token;
        refreshAll();
        setStatus(
          result.missing
            ? "Repo OK. gastos.json aún no existe; se creará al primer guardado."
            : "Datos cargados. Total gastos: " +
                formatUSD(resumen(result.data).totalGastos) +
                ".",
          "ok"
        );
        reveal($("total-gastos"));
      } catch (e) {
        setStatus(e.message || "No se pudieron cargar los datos.", "error");
        reveal($("status-msg"));
      }
    });

    async function runMutation(mutator, message, formErrorId) {
      syncConfigFromForm();
      var token = "";
      try {
        assertCfg(state.cfg);
        token = readTokenFromInput();
      } catch (e) {
        failForm(formErrorId, e.message || "Configuración o token inválido.");
        throw e;
      }
      if (!token) {
        failForm(
          formErrorId,
          "Falta el token. Pégalo arriba, pulsa «Cargar datos remotos» y vuelve a intentar."
        );
        throw new Error("Sin token");
      }
      if (!state.loaded) {
        failForm(
          formErrorId,
          "Antes hay que pulsar «Cargar datos remotos». Este movimiento no entró al total."
        );
        throw new Error("No cargado");
      }
      setStatus("Guardando en GitHub…", "info");
      try {
        var result = await client().mutate(state.cfg, token, mutator, message);
        state.data = result.data;
        if (result.sha) state.sha = result.sha;
        state.missing = false;
        state.token = token;
        refreshAll();
        var totals = resumen(result.data);
        var okMsg = result.skipped
          ? "Sin cambios nuevos. No se escribió en GitHub."
          : "Guardado en GitHub. Total gastos: " +
            formatUSD(totals.totalGastos) +
            ". Saldo pendiente: " +
            formatUSD(totals.saldoPendiente) +
            ".";
        setStatus(okMsg, result.skipped ? "info" : "ok");
        if (formErrorId) setFormError(formErrorId, okMsg, result.skipped ? "info" : "ok");
      } catch (e) {
        if (e && (e.message === "Sin token" || e.message === "No cargado")) throw e;
        failForm(formErrorId, e.message || "No se pudo guardar.");
        throw e;
      }
    }

    $("btn-cargar").addEventListener("click", onLoad);

    $("btn-guardar-config").addEventListener("click", function () {
      syncConfigFromForm();
      try {
        assertCfg(state.cfg);
        saveConfig(state.cfg);
      } catch (e) {
        setStatus(e.message || "No se pudo guardar la configuración en este navegador.", "error");
        return;
      }
      setStatus("Configuración del repo guardada en este navegador (sin token).", "ok");
    });

    $("btn-guardar-token").addEventListener("click", function () {
      var t = "";
      try {
        t = assertToken($("cfg-token").value || "");
      } catch (e) {
        setStatus(e.message || "Token inválido.", "error");
        return;
      }
      var ok = window.confirm(
        "Vas a guardar el token en localStorage de ESTE navegador.\n\n" +
          "Riesgo: cualquier script XSS o persona con acceso a este equipo podría leerlo.\n" +
          "No lo hagas en un equipo compartido.\n\n¿Continuar?"
      );
      if (!ok) return;
      try {
        saveToken(t);
      } catch (e) {
        setStatus("No se pudo guardar el token en este navegador.", "error");
        return;
      }
      state.token = t;
      $("cfg-token").value = t;
      $("token-saved-hint").hidden = false;
      setStatus("Token guardado solo en este navegador. Usa «Olvidar token» cuando termines.", "ok");
    });

    $("btn-olvidar-token").addEventListener("click", function () {
      try {
        forgetToken();
      } catch (e) {
        /* seguir limpiando la pantalla */
      }
      state.token = "";
      $("cfg-token").value = "";
      $("token-saved-hint").hidden = true;
      setStatus("Token eliminado de este navegador.", "ok");
    });

    $("form-gasto").addEventListener("submit", function (ev) {
      ev.preventDefault();
      setFormError("form-gasto", "");
      var fields = {
        fecha: $("gasto-fecha").value,
        descripcion: $("gasto-desc").value,
        categoria: $("gasto-cat").value,
        monto: $("gasto-monto").value,
      };
      try {
        addGasto(emptyData(), fields);
      } catch (localErr) {
        failForm("form-gasto", localErr.message);
        return;
      }
      withBusy(async function () {
        try {
          await runMutation(
            function (data) {
              return addGasto(data, fields);
            },
            "Agregar gasto operativo",
            "form-gasto"
          );
          $("form-gasto").reset();
          $("gasto-fecha").value = todayISO();
        } catch (e) {
          /* el formulario se conserva; el estado ya explica el fallo */
        }
      })();
    });

    $("form-pago").addEventListener("submit", function (ev) {
      ev.preventDefault();
      setFormError("form-pago", "");
      var fields = {
        fecha: $("pago-fecha").value,
        monto: $("pago-monto").value,
        gastoId: $("pago-gasto").value,
      };
      if (!state.loaded) {
        failForm(
          "form-pago",
          "Antes hay que pulsar «Cargar datos remotos». Este pago no entró al total."
        );
        return;
      }
      try {
        addPago(state.data, fields);
      } catch (localErr) {
        failForm("form-pago", localErr.message);
        return;
      }
      withBusy(async function () {
        try {
          await runMutation(
            function (data) {
              return addPago(data, fields);
            },
            "Registrar pago del jefe",
            "form-pago"
          );
          $("form-pago").reset();
          $("pago-fecha").value = todayISO();
          fillPagoSelect();
        } catch (e) {
          /* conservar montos escritos */
        }
      })();
    });

    function onDeleteGasto(id) {
      withBusy(async function () {
        try {
          var has = state.data.pagos.some(function (p) {
            return p.gastoId === id;
          });
          if (has) {
            var force = window.confirm(
              "Este gasto tiene pagos asociados.\n\n" +
                "Cancelar: no borrar.\nAceptar: borrar el gasto Y sus pagos (acción irreversible en el remoto)."
            );
            if (!force) return;
            await runMutation(
              function (data) {
                return deleteGasto(data, id, { force: true });
              },
              "Borrar gasto y pagos asociados"
            );
          } else {
            if (!window.confirm("¿Borrar este gasto?")) return;
            await runMutation(
              function (data) {
                return deleteGasto(data, id);
              },
              "Borrar gasto"
            );
          }
        } catch (e) {
          /* status ya mostrado */
        }
      })();
    }

    function onDeletePago(id) {
      withBusy(async function () {
        if (!window.confirm("¿Borrar este pago?")) return;
        try {
          await runMutation(
            function (data) {
              return deletePago(data, id);
            },
            "Borrar pago"
          );
        } catch (e) {
          /* status */
        }
      })();
    }

    $("filtro-estado").addEventListener("change", function () {
      state.filterEstado = $("filtro-estado").value;
      renderGastos();
    });
    $("filtro-categoria").addEventListener("change", function () {
      state.filterCategoria = $("filtro-categoria").value;
      renderGastos();
    });

    if (stripSecretsFromLocation()) {
      setStatus(
        "Se quitó un posible token de la dirección. Pégalo solo en el campo de contraseña, nunca en la URL.",
        "error"
      );
    }

    $("gasto-fecha").value = todayISO();
    $("pago-fecha").value = todayISO();
    fillConfigForm();

    var catSel = $("gasto-cat");
    CATEGORIAS.forEach(function (c) {
      catSel.appendChild(el("option", { value: c, text: c }));
    });
    var filtCat = $("filtro-categoria");
    CATEGORIAS.forEach(function (c) {
      filtCat.appendChild(el("option", { value: c, text: c }));
    });

    refreshAll();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUI);
    } else {
      initUI();
    }
  }

  return {
    DATA_VERSION: DATA_VERSION,
    DEFAULTS: DEFAULTS,
    CATEGORIAS: CATEGORIAS,
    emptyData: emptyData,
    validateData: validateData,
    parseDollarsToCents: parseDollarsToCents,
    toCents: toCents,
    formatUSD: formatUSD,
    isValidISODate: isValidISODate,
    paidCentsFor: paidCentsFor,
    estadoGasto: estadoGasto,
    resumen: resumen,
    addGasto: addGasto,
    addPago: addPago,
    deleteGasto: deleteGasto,
    deletePago: deletePago,
    createGithubClient: createGithubClient,
    b64EncodeUtf8: b64EncodeUtf8,
    b64DecodeUtf8: b64DecodeUtf8,
    redactSecrets: redactSecrets,
  };
});
