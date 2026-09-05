/**
 * The generic recipe: one directory per class.
 *
 * `train/rose/0001.jpg` is a rose; the label is the index of `rose` in the
 * sorted list of directory names actually present. Sorted, not
 * first-seen — the same archive prepared twice must produce the same label
 * for the same class, or two runs of the same eval are not comparable and
 * nobody would be able to tell from the numbers.
 *
 * It states no licence on purpose. A recipe that works for any pile of images
 * cannot know the terms of the pile it is pointed at, so `params.license` is
 * required and the prep refuses without it.
 */

/** The directory immediately above the file, which is the class. */
const classOf = (relPath) => {
  const parts = relPath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
};

export default {
  id: "dir-labels",
  license: null,
  size: 224,
  preprocess: "center-crop, resize 224, RGB; ImageNet mean/std applied on-device",

  labels(files) {
    const classes = [...new Set(files.map(classOf))].sort();
    return {
      classes: classes.length,
      items: files.map((f) => ({ label: classes.indexOf(classOf(f)), class: classOf(f) })),
    };
  },
};
