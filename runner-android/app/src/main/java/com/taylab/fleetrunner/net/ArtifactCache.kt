package com.taylab.fleetrunner.net

import android.content.Context
import java.io.File

/** Content-addressed on-device cache of collector artifacts (models, builds). */
class ArtifactCache(context: Context, private val client: CollectorClient) {

    private val dir = File(context.filesDir, "artifacts").apply { mkdirs() }

    /** Returns the local file for [sha256], downloading and verifying it if absent. */
    fun ensure(sha256: String): File {
        val file = File(dir, sha256)
        if (file.exists()) return file
        client.downloadArtifact(sha256, file)
        return file
    }
}
