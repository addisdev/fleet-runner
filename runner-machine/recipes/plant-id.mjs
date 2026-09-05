/**
 * PlantNet-300K, prepared for the plant-ID eval.
 *
 * The classes are not this recipe's to number: the model has 1081 outputs in
 * an order fixed at training time, so the directory name IS the class index
 * and inventing a compact 0..n-1 numbering from whichever species happen to be
 * in this archive would score every prediction against the wrong label. A
 * directory that is not a number in range is dropped rather than guessed at.
 *
 * The licence is stated here rather than left to the job. PlantNet-300K is
 * CC-BY-SA, which is the reason its images ship through the artifact store
 * instead of being committed, and a prepared set that arrives without the
 * attribution is a set whose eval results cannot be published anywhere.
 */

const CLASSES = 1081;

const classOf = (relPath) => {
  const parts = relPath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
};

export default {
  id: "plant-id",
  license: "CC-BY-SA-4.0",
  size: 224,
  preprocess: "center-crop, resize 224, RGB; ImageNet mean/std applied on-device",

  labels(files) {
    return {
      classes: CLASSES,
      items: files.map((f) => {
        const dir = classOf(f);
        const label = /^\d+$/.test(dir) ? Number(dir) : -1;
        return {
          // -1 rather than 0: an unlabelled image scored against class 0 would
          // quietly depress top-1 by however many files were misfiled, whereas
          // a label no prediction can equal shows up as a visible miss.
          label: label >= 0 && label < CLASSES ? label : -1,
          species_dir: dir,
        };
      }),
    };
  },
};
