import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) {
  throw new Error("Pass the directory that contains node_modules/nspell and node_modules/dictionary-en.");
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

const modules = ["nspell", "dictionary-en", "is-buffer"];
const sizes = {};
for (const name of modules) {
  sizes[name] = directoryBytes(path.join(root, "node_modules", name));
}
sizes.total = Object.values(sizes).reduce((sum, value) => sum + value, 0);

const dictionary = (await import(pathToFileURL(path.join(root, "node_modules", "dictionary-en", "index.js")).href)).default;
const nspell = (await import(pathToFileURL(path.join(root, "node_modules", "nspell", "lib", "index.js")).href)).default;
const spell = nspell(dictionary);
const terms = [
  "TypeScript",
  "JavaScript",
  "PostgreSQL",
  "Kubernetes",
  "GraphQL",
  "Fastify",
  "Drizzle",
  "MongoDB",
  "Redis",
  "DevOps",
  "OAuth",
  "webpack",
  "Next.js",
  "Node.js",
  "gRPC",
  "Terraform",
  "Docker",
  "Nginx",
  "Elasticsearch",
  "SaaS",
  "JWT",
  "NoSQL",
  "MySQL",
  "SQLite",
  "Firestore",
  "DynamoDB",
  "WebSocket",
  "microservices",
  "serverless",
  "frontend",
  "backend",
  "fullstack",
  "ReactJS",
  "pnpm",
  "npm",
  "GitHub",
  "LinkedIn",
  "async",
  "regex",
  "localhost",
  "JSON",
  "YAML",
  "ORM",
  "SSR",
  "SEO",
  "KPI",
  "OKR",
  "iOS",
  "macOS",
  "protobuf",
  "Ansible",
  "Jenkins",
  "Grafana",
  "Prometheus",
  "Kibana",
  "Dockerfile",
  "IAM",
  "CRUD",
  "B2B",
  "UX",
  "UI",
  "APIs",
];
const unique = [...new Set(terms)];
const unknown = unique.filter((term) => spell.correct(term) !== true);
const controls = ["color", "managed", "developed", "experience", "university"];
const controlResults = Object.fromEntries(controls.map((word) => [word, spell.correct(word) === true]));
process.stdout.write(`${JSON.stringify({ sizes, unknown, unknownCount: unknown.length, termCount: unique.length, controlResults })}\n`);
