/**
 * Recipes: how a downloaded pile of images becomes a labelled eval set.
 *
 * A recipe is a small ES module under `recipes/`, named by the job. Keeping it
 * out of this file is the point — a new dataset is a new file next to the
 * others, not a branch in a workload — but it also means the recipe NAME
 * arrives from an unauthenticated `POST /jobs`, so `recipePath` is a security
 * boundary and not a convenience: `../../etc/something` must never resolve.
 *
 * The manifest is the other half. Its shape is not this file's invention: the
 * Android runner's VisionEvalEngine reads `manifest.json` from the zip root
 * and walks `items[].file` / `items[].label`, so those two keys are a contract
 * with code in another repo and are asserted in the tests rather than trusted.
 *
 * `license` and `source` are new here, and they are the reason a prepared set
 * is publishable. The plant dataset is CC-BY-SA — which is exactly why its
 * images ship as artifacts rather than as commits — and a zip that has lost
 * the attribution is a zip whose results can never appear in a write-up. So a
 * set with no licence is refused at prep time, where somebody can still fix
 * it, rather than discovered at publication time when the provenance is gone.
 */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** A recipe name is a filename, never a path. */
export const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type LabelledItem = { label: number; [k: string]: unknown };
export type Labelling = { items: LabelledItem[]; classes?: number };

export type Recipe = {
  id: string;
  /**
   * The dataset's licence, when the recipe is for one specific dataset. Null
   * for a generic recipe, which means the JOB has to say — and a job that does
   * not is refused.
   */
  license: string | null;
  /** Square edge, in pixels, of every image in the prepared set. */
  size: number;
  /** Copied into the manifest so the runners' preprocessing is documented beside the data. */
  preprocess?: string;
  /**
   * Labels for the whole file list at once, in the same order.
   *
   * Whole-list rather than per-file because a label is usually an INDEX into
   * the set of classes present, which no single file can know. Returning fewer
   * items than it was given is a refusal the caller reports.
   */
  labels(files: string[]): Labelling;
};

/** Where the recipes live. Overridable so the tests do not need the real ones. */
export function recipesDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLEET_RECIPES_DIR) return env.FLEET_RECIPES_DIR;
  // runner-machine/src/recipes.ts -> runner-machine/recipes. fileURLToPath
  // rather than `.pathname`, because this checkout's path has a space in it.
  return fileURLToPath(new URL("../recipes", import.meta.url));
}

/**
 * The file a recipe name refers to.
 *
 * Throws for anything that is not a plain lowercase name. The name comes from
 * a job spec and the collector authenticates nobody, so `../../../..` reaching
 * `import()` would be arbitrary code execution with no allowlist in front of
 * it — which is the thing the `shell` workload has a whole allowlist to avoid.
 */
export function recipePath(name: unknown, dir: string): string {
  if (typeof name !== "string" || !RECIPE_NAME_RE.test(name)) {
    throw new Error(
      `params.recipe must be a recipe name like 'plant-id' (lowercase, no path separators); got ${JSON.stringify(name)}`,
    );
  }
  const file = path.join(dir, `${name}.mjs`);
  // Belt and braces: the regex already forbids separators, so a resolved path
  // that escaped the directory would mean the regex was weakened later.
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
    throw new Error(`recipe '${name}' does not resolve inside ${dir}`);
  }
  return file;
}

/** A loaded module is only a recipe if it answers every question the prep asks. */
export function asRecipe(mod: unknown, name: string): Recipe {
  const r = (mod && typeof mod === "object" && "default" in mod ? (mod as { default: unknown }).default : mod) as
    | Partial<Recipe>
    | undefined;
  if (!r || typeof r !== "object") throw new Error(`recipe '${name}' exports no default object`);
  if (typeof r.labels !== "function") throw new Error(`recipe '${name}' has no labels(files) function`);
  if (typeof r.size !== "number" || !Number.isInteger(r.size) || r.size < 16 || r.size > 4096) {
    throw new Error(`recipe '${name}' has no usable size (got ${JSON.stringify(r.size)})`);
  }
  if (r.license !== null && typeof r.license !== "string") {
    throw new Error(`recipe '${name}' must state a license string, or null to require one from the job`);
  }
  return {
    id: typeof r.id === "string" && r.id !== "" ? r.id : name,
    license: r.license,
    size: r.size,
    preprocess: typeof r.preprocess === "string" ? r.preprocess : undefined,
    labels: r.labels.bind(r),
  };
}

export async function loadRecipe(name: unknown, env: NodeJS.ProcessEnv = process.env): Promise<Recipe> {
  const dir = recipesDir(env);
  const file = recipePath(name, dir);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`recipe '${String(name)}' does not load from ${dir}: ${(e as Error).message}`);
  }
  return asRecipe(mod, String(name));
}

/**
 * The licence the prepared set will carry.
 *
 * The job may override a generic recipe's null; it may NOT quietly relabel a
 * recipe that already knows its dataset's terms, because the recipe is the
 * thing somebody checked. An empty answer is a refusal, not a blank field.
 */
export function effectiveLicense(recipe: Recipe, fromJob: unknown): string {
  const job = typeof fromJob === "string" ? fromJob.trim() : "";
  if (recipe.license !== null && recipe.license.trim() !== "") {
    if (job !== "" && job !== recipe.license) {
      throw new Error(
        `recipe '${recipe.id}' states its dataset is ${recipe.license}; params.license says ${job}. A prep cannot relicense a dataset.`,
      );
    }
    return recipe.license;
  }
  if (job === "") {
    throw new Error(
      `recipe '${recipe.id}' is generic and states no license, so params.license is required — a prepared set with no licence is one nobody can publish results from`,
    );
  }
  return job;
}

export type Manifest = {
  recipe: string;
  /** Where the images came from, so the set is traceable without this job's row. */
  source: string;
  license: string;
  classes?: number;
  preprocess?: string;
  items: LabelledItem[];
};

/**
 * The manifest that goes in the zip.
 *
 * `items[].file` is the name inside the zip and `items[].label` is an integer,
 * because that is what VisionEvalEngine reads; everything the recipe attached
 * to an item rides along untouched, the way the plant-ID manifest carries
 * `species` and `species_id` beside the label.
 */
export function buildManifest(opts: {
  recipe: Recipe;
  source: string;
  license: string;
  names: string[];
  labelling: Labelling;
}): Manifest {
  const { recipe, names, labelling } = opts;
  if (labelling.items.length !== names.length) {
    throw new Error(
      `recipe '${recipe.id}' labelled ${labelling.items.length} of ${names.length} images; the manifest must describe every file in the zip`,
    );
  }
  const items = names.map((file, i) => {
    const item = labelling.items[i]!;
    if (!Number.isInteger(item.label)) {
      throw new Error(`recipe '${recipe.id}' gave ${file} a non-integer label (${JSON.stringify(item.label)})`);
    }
    // `file` last so a recipe cannot overwrite the name of the file it is
    // describing — the zip's layout is the prep's to decide, not the recipe's.
    return { ...item, label: item.label, file };
  });
  return {
    recipe: recipe.id,
    source: opts.source,
    license: opts.license,
    ...(labelling.classes !== undefined ? { classes: labelling.classes } : {}),
    ...(recipe.preprocess ? { preprocess: recipe.preprocess } : {}),
    items,
  };
}

/** `000.jpg`, `001.jpg`, … — flat, zero-padded, and in the order they were kept. */
export function outputName(index: number, total: number): string {
  const width = Math.max(3, String(Math.max(total - 1, 0)).length);
  return `${String(index).padStart(width, "0")}.jpg`;
}
