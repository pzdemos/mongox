#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import inquirer from "inquirer";
import chalk from "chalk";
import Table from "cli-table3";
import yaml from "js-yaml";
import { EJSON } from "bson";
import { MongoClient } from "mongodb";

const state = {
  client: null,
  uri: "",
  dbName: "",
  collectionName: "",
  viewMode: "table",
};

const VIEW_MODES = [
  { name: "表格视图 (Table)", value: "table" },
  { name: "JSON 视图", value: "json" },
  { name: "树形视图 (Tree)", value: "tree" },
];

function printBanner() {
  console.log(chalk.cyan("\nMongoDB Admin CLI"));
  console.log(chalk.gray("连接本地/远程 MongoDB，执行 CRUD，支持多视图与多格式导出。\n"));
}

function shortValue(value, maxLength = 64) {
  const raw = typeof value === "string" ? value : EJSON.stringify(value, { relaxed: false });
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
}

function parseExtendedJson(text, fallback = undefined) {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    return EJSON.parse(trimmed);
  } catch (error) {
    throw new Error(`JSON/EJSON 解析失败: ${error.message}`);
  }
}

function collectionRef() {
  if (!state.client || !state.dbName || !state.collectionName) {
    return null;
  }

  return state.client.db(state.dbName).collection(state.collectionName);
}

function printStatus() {
  const lines = [
    `URI: ${state.uri || "(未连接)"}`,
    `Database: ${state.dbName || "(未选择)"}`,
    `Collection: ${state.collectionName || "(未选择)"}`,
    `View Mode: ${state.viewMode}`,
  ];

  console.log(chalk.yellow("\n当前状态"));
  for (const line of lines) {
    console.log(`- ${line}`);
  }
  console.log("");
}

async function connectMongo() {
  const { uri } = await inquirer.prompt([
    {
      type: "input",
      name: "uri",
      message: "请输入 MongoDB 连接字符串:",
      default: state.uri || "mongodb://127.0.0.1:27017",
    },
  ]);

  if (state.client) {
    await state.client.close();
    state.client = null;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  await client.db("admin").command({ ping: 1 });

  state.client = client;
  state.uri = uri;
  state.dbName = "";
  state.collectionName = "";

  console.log(chalk.green("连接成功。\n"));
}

async function chooseDatabase() {
  if (!state.client) {
    console.log(chalk.red("请先连接 MongoDB。\n"));
    return;
  }

  const admin = state.client.db("admin");
  const list = await admin.listDatabases();
  const dbChoices = list.databases.map((d) => ({
    name: `${d.name} (${d.sizeOnDisk} bytes)`,
    value: d.name,
  }));

  dbChoices.unshift({
    name: "手动输入数据库名",
    value: "__manual__",
  });

  const { dbName } = await inquirer.prompt([
    {
      type: "list",
      name: "dbName",
      message: "选择数据库:",
      pageSize: 12,
      choices: dbChoices,
    },
  ]);

  if (dbName === "__manual__") {
    const { manualDb } = await inquirer.prompt([
      {
        type: "input",
        name: "manualDb",
        message: "输入数据库名:",
        validate: (input) => (input.trim() ? true : "数据库名不能为空"),
      },
    ]);
    state.dbName = manualDb.trim();
  } else {
    state.dbName = dbName;
  }

  state.collectionName = "";
  console.log(chalk.green(`当前数据库: ${state.dbName}\n`));
}

async function chooseCollection() {
  if (!state.client || !state.dbName) {
    console.log(chalk.red("请先选择数据库。\n"));
    return;
  }

  const db = state.client.db(state.dbName);
  const collections = await db.listCollections().toArray();
  const choices = collections.map((c) => ({
    name: c.name,
    value: c.name,
  }));

  choices.unshift({ name: "手动输入集合名", value: "__manual__" });

  const { selected } = await inquirer.prompt([
    {
      type: "list",
      name: "selected",
      message: "选择集合:",
      pageSize: 12,
      choices,
    },
  ]);

  if (selected === "__manual__") {
    const { manualCollection } = await inquirer.prompt([
      {
        type: "input",
        name: "manualCollection",
        message: "输入集合名:",
        validate: (input) => (input.trim() ? true : "集合名不能为空"),
      },
    ]);
    state.collectionName = manualCollection.trim();
  } else {
    state.collectionName = selected;
  }

  console.log(chalk.green(`当前集合: ${state.collectionName}\n`));
}

async function ensureReady() {
  if (!state.client) {
    console.log(chalk.red("请先连接 MongoDB。\n"));
    return false;
  }

  if (!state.dbName) {
    await chooseDatabase();
  }
  if (!state.collectionName) {
    await chooseCollection();
  }

  return Boolean(state.dbName && state.collectionName);
}

async function promptQueryOptions() {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "filter",
      message: "过滤条件 JSON/EJSON (默认 {}):",
      default: "{}",
    },
    {
      type: "input",
      name: "projection",
      message: "字段投影 JSON/EJSON (可选):",
      default: "",
    },
    {
      type: "input",
      name: "sort",
      message: "排序 JSON/EJSON (可选, 例: {\"createdAt\":-1}):",
      default: "",
    },
    {
      type: "number",
      name: "limit",
      message: "返回条数限制:",
      default: 20,
      validate: (n) => (Number.isInteger(n) && n > 0 ? true : "请输入正整数"),
    },
  ]);

  return {
    filter: parseExtendedJson(answers.filter, {}),
    projection: parseExtendedJson(answers.projection, undefined),
    sort: parseExtendedJson(answers.sort, undefined),
    limit: answers.limit,
  };
}

function renderTable(docs) {
  if (!docs.length) {
    console.log(chalk.gray("没有匹配数据。\n"));
    return;
  }

  const columnSet = new Set(["_id"]);
  for (const doc of docs.slice(0, 20)) {
    for (const key of Object.keys(doc)) {
      columnSet.add(key);
      if (columnSet.size >= 8) {
        break;
      }
    }
    if (columnSet.size >= 8) {
      break;
    }
  }

  const headers = [...columnSet];
  const table = new Table({
    head: headers,
    wordWrap: true,
    style: { head: ["cyan"] },
  });

  for (const doc of docs) {
    table.push(headers.map((key) => shortValue(doc[key])));
  }

  console.log(table.toString());
  console.log("");
}

function renderJson(docs) {
  console.log(EJSON.stringify(docs, { relaxed: false, indent: 2 }));
  console.log("");
}

function renderTree(docs) {
  if (!docs.length) {
    console.log(chalk.gray("没有匹配数据。\n"));
    return;
  }

  docs.forEach((doc, index) => {
    console.log(chalk.cyan(`Document #${index + 1}`));
    console.log(util.inspect(doc, { colors: true, depth: null, compact: false }));
  });
  console.log("");
}

function renderDocs(docs) {
  if (state.viewMode === "json") {
    renderJson(docs);
    return;
  }

  if (state.viewMode === "tree") {
    renderTree(docs);
    return;
  }

  renderTable(docs);
}

async function queryDocuments() {
  if (!(await ensureReady())) {
    return;
  }

  const options = await promptQueryOptions();
  const coll = collectionRef();
  const cursor = coll.find(options.filter);

  if (options.projection) {
    cursor.project(options.projection);
  }
  if (options.sort) {
    cursor.sort(options.sort);
  }

  const docs = await cursor.limit(options.limit).toArray();
  renderDocs(docs);
}

async function insertDocument() {
  if (!(await ensureReady())) {
    return;
  }

  const { docText } = await inquirer.prompt([
    {
      type: "editor",
      name: "docText",
      message: "输入要插入的 JSON/EJSON 文档:",
      default: "{\n  \"name\": \"demo\",\n  \"createdAt\": {\"$date\": \"2026-01-01T00:00:00Z\"}\n}",
    },
  ]);

  const doc = parseExtendedJson(docText);
  const result = await collectionRef().insertOne(doc);
  console.log(chalk.green(`插入成功: ${result.insertedId}\n`));
}

async function updateDocuments() {
  if (!(await ensureReady())) {
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "更新模式:",
      choices: [
        { name: "updateOne", value: "one" },
        { name: "updateMany", value: "many" },
      ],
    },
    {
      type: "input",
      name: "filterText",
      message: "过滤条件 JSON/EJSON:",
      default: "{}",
    },
    {
      type: "editor",
      name: "updateText",
      message: "更新内容 JSON/EJSON (例: {\"$set\":{\"status\":\"active\"}}):",
      default: "{\n  \"$set\": {\n    \"updatedAt\": {\"$date\": \"2026-01-01T00:00:00Z\"}\n  }\n}",
    },
  ]);

  const filter = parseExtendedJson(answers.filterText, {});
  let updateDoc = parseExtendedJson(answers.updateText);

  const hasOperator = Object.keys(updateDoc).some((k) => k.startsWith("$"));
  if (!hasOperator) {
    const { wrapAsSet } = await inquirer.prompt([
      {
        type: "confirm",
        name: "wrapAsSet",
        message: "未检测到更新操作符。是否自动包装为 $set?",
        default: true,
      },
    ]);
    if (wrapAsSet) {
      updateDoc = { $set: updateDoc };
    }
  }

  const coll = collectionRef();
  const result =
    answers.mode === "one"
      ? await coll.updateOne(filter, updateDoc)
      : await coll.updateMany(filter, updateDoc);

  console.log(
    chalk.green(
      `更新完成: matched=${result.matchedCount}, modified=${result.modifiedCount}, upserted=${result.upsertedCount}\n`,
    ),
  );
}

async function deleteDocuments() {
  if (!(await ensureReady())) {
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "删除模式:",
      choices: [
        { name: "deleteOne", value: "one" },
        { name: "deleteMany", value: "many" },
      ],
    },
    {
      type: "input",
      name: "filterText",
      message: "过滤条件 JSON/EJSON:",
      default: "{}",
    },
    {
      type: "confirm",
      name: "confirmed",
      message: "确认执行删除?",
      default: false,
    },
  ]);

  if (!answers.confirmed) {
    console.log(chalk.yellow("已取消删除。\n"));
    return;
  }

  const filter = parseExtendedJson(answers.filterText, {});
  const coll = collectionRef();
  const result =
    answers.mode === "one" ? await coll.deleteOne(filter) : await coll.deleteMany(filter);

  console.log(chalk.green(`删除完成: deleted=${result.deletedCount}\n`));
}

async function collectionStats() {
  if (!(await ensureReady())) {
    return;
  }

  const coll = collectionRef();
  const [estimated, accurate, indexes] = await Promise.all([
    coll.estimatedDocumentCount(),
    coll.countDocuments(),
    coll.indexes(),
  ]);

  console.log(chalk.cyan("集合概览"));
  console.log(`- Estimated Count: ${estimated}`);
  console.log(`- Accurate Count: ${accurate}`);
  console.log(`- Indexes: ${indexes.length}`);

  try {
    const details = await state.client
      .db(state.dbName)
      .command({ collStats: state.collectionName, scale: 1 });
    console.log(`- Storage Size: ${details.storageSize} bytes`);
    console.log(`- Avg Obj Size: ${details.avgObjSize ?? "N/A"}`);
  } catch {
    console.log("- Storage Stats: 无权限或实例不支持");
  }

  console.log("");
}

function toCsv(docs) {
  if (!docs.length) {
    return "";
  }

  const keys = [...new Set(docs.flatMap((d) => Object.keys(d)))];
  const escapeCell = (value) => {
    const text = shortValue(value, 10000).replaceAll('"', '""');
    return `"${text}"`;
  };

  const header = keys.join(",");
  const body = docs.map((doc) => keys.map((k) => escapeCell(doc[k])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

async function exportDocuments() {
  if (!(await ensureReady())) {
    return;
  }

  const options = await promptQueryOptions();
  const coll = collectionRef();
  const cursor = coll.find(options.filter);

  if (options.projection) {
    cursor.project(options.projection);
  }
  if (options.sort) {
    cursor.sort(options.sort);
  }

  const docs = await cursor.limit(options.limit).toArray();
  if (!docs.length) {
    console.log(chalk.yellow("没有数据可导出。\n"));
    return;
  }

  const { format } = await inquirer.prompt([
    {
      type: "list",
      name: "format",
      message: "选择导出格式:",
      choices: ["json", "yaml", "csv", "ndjson"],
    },
  ]);

  const defaultPath = path.resolve(
    process.cwd(),
    `export_${state.dbName}_${state.collectionName}_${Date.now()}.${format}`,
  );

  const { outputPath } = await inquirer.prompt([
    {
      type: "input",
      name: "outputPath",
      message: "导出文件路径:",
      default: defaultPath,
    },
  ]);

  let content = "";
  switch (format) {
    case "json":
      content = EJSON.stringify(docs, { relaxed: false, indent: 2 });
      break;
    case "yaml":
      content = yaml.dump(JSON.parse(EJSON.stringify(docs, { relaxed: true })));
      break;
    case "ndjson":
      content = docs.map((d) => EJSON.stringify(d, { relaxed: false })).join("\n");
      break;
    case "csv":
      content = toCsv(docs);
      break;
    default:
      throw new Error(`不支持的格式: ${format}`);
  }

  const absolutePath = path.resolve(outputPath);
  await fs.writeFile(absolutePath, content, "utf8");
  console.log(chalk.green(`导出完成: ${absolutePath}\n`));
}

async function switchView() {
  const { viewMode } = await inquirer.prompt([
    {
      type: "list",
      name: "viewMode",
      message: "选择查询结果视图:",
      choices: VIEW_MODES,
      default: state.viewMode,
    },
  ]);

  state.viewMode = viewMode;
  console.log(chalk.green(`当前视图: ${state.viewMode}\n`));
}

async function closeClient() {
  if (state.client) {
    await state.client.close();
    state.client = null;
  }
}

async function mainMenu() {
  let running = true;
  while (running) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        pageSize: 14,
        choices: [
          { name: "连接/重连 MongoDB", value: "connect" },
          { name: "选择数据库", value: "db" },
          { name: "选择集合", value: "collection" },
          { name: "查询文档 (Read)", value: "query" },
          { name: "新增文档 (Create)", value: "insert" },
          { name: "更新文档 (Update)", value: "update" },
          { name: "删除文档 (Delete)", value: "delete" },
          { name: "集合概览", value: "stats" },
          { name: "导出查询结果", value: "export" },
          { name: "切换视图", value: "view" },
          { name: "显示当前状态", value: "status" },
          { name: "退出", value: "exit" },
        ],
      },
    ]);

    try {
      switch (action) {
        case "connect":
          await connectMongo();
          break;
        case "db":
          await chooseDatabase();
          break;
        case "collection":
          await chooseCollection();
          break;
        case "query":
          await queryDocuments();
          break;
        case "insert":
          await insertDocument();
          break;
        case "update":
          await updateDocuments();
          break;
        case "delete":
          await deleteDocuments();
          break;
        case "stats":
          await collectionStats();
          break;
        case "export":
          await exportDocuments();
          break;
        case "view":
          await switchView();
          break;
        case "status":
          printStatus();
          break;
        case "exit":
          running = false;
          break;
        default:
          break;
      }
    } catch (error) {
      console.log(chalk.red(`操作失败: ${error.message}\n`));
    }
  }
}

async function bootstrap() {
  printBanner();
  let connected = false;
  while (!connected) {
    const { doConnect } = await inquirer.prompt([
      {
        type: "confirm",
        name: "doConnect",
        message: "现在连接 MongoDB 吗?",
        default: true,
      },
    ]);

    if (!doConnect) {
      break;
    }

    try {
      await connectMongo();
      connected = true;
    } catch (error) {
      console.log(chalk.red(`连接失败: ${error.message}\n`));
    }
  }

  await mainMenu();
  await closeClient();
  console.log(chalk.gray("已退出。"));
}

process.on("SIGINT", async () => {
  await closeClient();
  process.exit(0);
});

bootstrap().catch(async (error) => {
  console.error(chalk.red(`程序异常退出: ${error.message}`));
  await closeClient();
  process.exit(1);
});
