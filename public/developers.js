const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const searchInput = document.querySelector("#operation-search");
const serviceFilter = document.querySelector("#service-filter");
const reference = document.querySelector("#api-reference");
const copyStatus = document.querySelector("#copy-status");
const operationTotal = document.querySelector("#operation-total");
let operations = [];

document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-copy]");
  if (!(button instanceof HTMLButtonElement)) return;
  const source = document.getElementById(button.dataset.copy ?? "");
  if (!source) return;
  try {
    await navigator.clipboard.writeText(source.innerText);
    const previous = button.textContent;
    button.textContent = "Copied";
    if (copyStatus) copyStatus.textContent = "Code copied to clipboard";
    window.setTimeout(() => { button.textContent = previous; }, 1400);
  } catch {
    source.focus?.();
    button.textContent = "Select text";
    if (copyStatus) copyStatus.textContent = "Clipboard unavailable; select and copy the code";
  }
});

Promise.resolve(fetch("/openapi.json", { headers: { Accept: "application/json" } }))
  .then((response) => {
    if (!response.ok) throw new Error(`OpenAPI returned ${response.status}`);
    return response.json();
  })
  .then((document) => {
    operations = collectOperations(document);
    if (operationTotal) operationTotal.textContent = `${operations.length} operations`;
    populateServices(operations);
    renderOperations(operations);
    searchInput?.addEventListener("input", filterOperations);
    serviceFilter?.addEventListener("change", filterOperations);
  })
  .catch(() => {
    if (operationTotal) operationTotal.textContent = "Unavailable";
    if (!reference) return;
    reference.replaceChildren(element("p", "The rendered reference is unavailable. Download openapi.json using the link above."));
  });

function collectOperations(document) {
  const result = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      result.push({
        path,
        method: method.toUpperCase(),
        service: operation.tags?.[0] ?? "Other",
        id: operation.operationId ?? `${method}-${path}`,
        summary: operation.summary ?? "",
        description: operation.description ?? "",
        authentication: operation["x-authentication"] ?? "member",
        safety: operation["x-change-safety"] ?? "unspecified",
        server: operation.servers?.[0]?.url ?? document.servers?.[0]?.url ?? "",
        parameters: resolveParameters(operation.parameters ?? [], document),
        requestBody: operation.requestBody,
        responses: operation.responses ?? {},
      });
    }
  }
  return result.sort((left, right) => left.service.localeCompare(right.service) || left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function resolveParameters(parameters, document) {
  return parameters.map((parameter) => {
    if (!parameter.$ref) return parameter;
    const name = parameter.$ref.split("/").at(-1);
    return document.components?.parameters?.[name] ?? parameter;
  });
}

function populateServices(items) {
  if (!(serviceFilter instanceof HTMLSelectElement)) return;
  for (const service of [...new Set(items.map((item) => item.service))]) {
    const option = document.createElement("option");
    option.value = service;
    option.textContent = service;
    serviceFilter.append(option);
  }
}

function filterOperations() {
  const query = searchInput instanceof HTMLInputElement ? searchInput.value.trim().toLowerCase() : "";
  const service = serviceFilter instanceof HTMLSelectElement ? serviceFilter.value : "";
  const filtered = operations.filter((operation) => {
    const matchesService = !service || operation.service === service;
    const haystack = `${operation.service} ${operation.method} ${operation.path} ${operation.id} ${operation.summary}`.toLowerCase();
    return matchesService && (!query || haystack.includes(query));
  });
  renderOperations(filtered);
}

function renderOperations(items) {
  if (!reference) return;
  if (items.length === 0) {
    reference.replaceChildren(element("p", "No operations match this filter."));
    return;
  }
  const groups = new Map();
  for (const operation of items) {
    const group = groups.get(operation.service) ?? [];
    group.push(operation);
    groups.set(operation.service, group);
  }
  const fragment = document.createDocumentFragment();
  for (const [service, serviceOperations] of groups) {
    const section = element("section", "", "reference-group");
    const heading = element("h3", service);
    heading.append(element("span", `${serviceOperations.length} operations`, "operation-count"));
    section.append(heading);
    for (const operation of serviceOperations) section.append(operationCard(operation));
    fragment.append(section);
  }
  reference.replaceChildren(fragment);
}

function operationCard(operation) {
  const details = element("details", "", "operation-card");
  const summary = document.createElement("summary");
  summary.append(
    element("span", operation.method, `method-badge method-${operation.method.toLowerCase()}`),
    element("code", operation.path, "operation-path"),
    element("span", operation.summary, "operation-summary"),
  );
  const body = element("div", "", "operation-body");
  const badges = element("div", "", "operation-meta");
  badges.append(
    element("span", `Access: ${humanize(operation.authentication)}`, "meta-badge"),
    element("span", `Safety: ${humanize(operation.safety)}`, safetyClass(operation.safety)),
  );
  body.append(badges);
  if (operation.description) body.append(element("p", operation.description));
  body.append(definition("Operation ID", operation.id));
  if (operation.server && operation.server !== "https://app.unticket.ai") body.append(definition("Server", operation.server));
  if (operation.parameters.length > 0) {
    const list = document.createElement("ul");
    for (const parameter of operation.parameters) {
      const required = parameter.required ? "required" : "optional";
      const schema = schemaName(parameter.schema);
      const item = document.createElement("li");
      item.append(element("code", parameter.name ?? "parameter"), document.createTextNode(` · ${parameter.in ?? "request"} · ${required} · ${schema}`));
      if (parameter.description) item.append(document.createTextNode(` — ${parameter.description}`));
      list.append(item);
    }
    body.append(subsection("Parameters", list));
  }
  if (operation.requestBody) {
    const types = Object.entries(operation.requestBody.content ?? {}).map(([mediaType, media]) => `${mediaType} · ${schemaName(media.schema)}`).join(", ");
    body.append(definition("Request body", `${operation.requestBody.required ? "required" : "optional"} · ${types || "schema not declared"}`));
  }
  const responseList = document.createElement("ul");
  for (const [status, response] of Object.entries(operation.responses)) {
    const schema = response.$ref ? response.$ref.split("/").at(-1) : Object.values(response.content ?? {})[0]?.schema;
    const item = document.createElement("li");
    item.append(element("code", status), document.createTextNode(` · ${response.description ?? "Response"}`));
    if (schema) item.append(document.createTextNode(` · ${typeof schema === "string" ? schema : schemaName(schema)}`));
    responseList.append(item);
  }
  body.append(subsection("Responses", responseList));
  details.append(summary, body);
  return details;
}

function definition(label, value) {
  const row = element("p", "", "definition-row");
  row.append(element("strong", label), document.createTextNode(` ${value}`));
  return row;
}

function subsection(title, content) {
  const section = element("div", "", "operation-subsection");
  section.append(element("strong", title), content);
  return section;
}

function schemaName(schema) {
  if (!schema) return "unspecified";
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
  if (schema.oneOf) return "one of several schemas";
  return "schema";
}

function safetyClass(safety) {
  return safety === "safe_read" ? "meta-badge safe-badge" : safety === "destructive" ? "meta-badge danger-badge" : "meta-badge caution-badge";
}

function humanize(value) {
  return String(value).replaceAll("_", " ");
}

function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
