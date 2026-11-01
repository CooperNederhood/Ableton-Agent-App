const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  require.resolve("./producer_identity.js"),
  "utf8"
);

function fixture(watch = true) {
  const output = [];
  const tasks = [];
  const posts = [];
  let deviceAvailable = true;
  let invalidNameQueries = 0;
  const context = {
    Array,
    Number,
    String,
    JSON,
    isFinite,
    jsarguments: watch ? ["producer_identity.js", "watch"] : [],
    LiveAPI: function LiveAPI(apiPath) {
      const device = apiPath === "live_set this_device";
      const available = !device || deviceAvailable;
      return {
        id: available ? (device ? 29 : 17) : 0,
        type: device ? "MaxDevice" : "Track",
        unquotedpath: available
          ? device
            ? "live_set tracks 0 devices 1"
            : "live_set tracks 0"
          : "",
        get(property) {
          assert.equal(property, "name");
          if (!available) {
            invalidNameQueries++;
            throw new Error("get: no valid object set");
          }
          return device ? "Owned listener" : "Owned track";
        }
      };
    },
    Task: function Task(callback, target, ...args) {
      const task = {
        cancelled: false,
        cancel() {
          task.cancelled = true;
        },
        schedule(delay) {
          task.delay = delay;
          tasks.push(task);
        },
        run() {
          if (!task.cancelled) callback.apply(target, args);
        }
      };
      return task;
    },
    outlet: (...atoms) => output.push(atoms),
    post: (...atoms) => posts.push(atoms)
  };
  vm.runInNewContext(source, context);
  return {
    output,
    tasks,
    posts,
    start: () => context.bang(),
    delete: () => context.notifydeleted(),
    setAvailable: (value) => {
      deviceAvailable = value;
    },
    invalidQueries: () => invalidNameQueries,
    refresh() {
      const task = tasks.shift();
      assert.ok(task);
      task.run();
    }
  };
}

test("watch reports unavailable placement without querying an invalid Live object and recovers the actual identity", () => {
  const f = fixture();
  f.start();
  const identity = JSON.parse(f.output[0][2]);
  assert.equal(identity.canonicalPath, "live_set tracks 0 devices 1");
  f.setAvailable(false);
  f.refresh();
  assert.deepEqual(f.output.at(-1), [0, "identity-unavailable"]);
  assert.equal(f.invalidQueries(), 0);
  const unavailableCount = f.output.length;
  f.refresh();
  assert.equal(f.output.length, unavailableCount);
  f.setAvailable(true);
  f.refresh();
  assert.deepEqual(JSON.parse(f.output.at(-1)[2]), identity);
  assert.equal(f.invalidQueries(), 0);
});

test("cold watch waits for a valid object without issuing name queries against id zero", () => {
  const f = fixture();
  f.setAvailable(false);
  f.start();
  assert.deepEqual(f.output, [[0, "identity-unavailable"]]);
  assert.equal(f.invalidQueries(), 0);
  assert.equal(f.tasks[0].delay, 500);
  f.setAvailable(true);
  f.refresh();
  assert.equal(f.output.at(-1)[1], "identity");
});

test("bounded cold retries never query an invalid object and stop after the declared retry limit", () => {
  const f = fixture(false);
  f.setAvailable(false);
  f.start();
  while (f.tasks.length) {
    assert.equal(f.tasks[0].delay, 250);
    f.refresh();
  }
  assert.equal(f.output.length, 0);
  assert.equal(f.invalidQueries(), 0);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0][0], /identity unavailable after 20 retries/);
});

test("deleting a watched producer cancels its scheduled placement refresh", () => {
  const f = fixture();
  f.start();
  f.delete();
  f.setAvailable(false);
  f.refresh();
  assert.equal(f.output.length, 1);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.invalidQueries(), 0);
});
