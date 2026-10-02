package dev.fleetrunner.buggarden

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.Density

/**
 * The only activity. Reads the defect switch from the launch intent, then
 * hands over to Compose.
 *
 * The switch is a string extra because that is what the explore harness can
 * pass: a mission's `launch_args: ["garden_defects=false"]` becomes
 * `am start ... --es garden_defects false`. Maestro's `launchApp: arguments:`
 * passes extras too, possibly typed, so a boolean false is accepted as well.
 * No extra means defects on.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyLaunchExtras(intent)
        setContent { SproutApp() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyLaunchExtras(intent)
    }

    private fun applyLaunchExtras(intent: Intent?) {
        @Suppress("DEPRECATION")
        val raw = intent?.extras?.get("garden_defects") ?: return
        val on = when (raw) {
            is Boolean -> raw
            else -> raw.toString().trim().lowercase() !in setOf("false", "0", "off", "no")
        }
        if (on != Garden.defects) {
            // A launch that changes the mode starts the garden over, so the
            // seed data (the Calathea note differs) matches the mode.
            Garden.defects = on
            Garden.reseed()
            Garden.signOut()
            Nav.resetTo(Screen.SignIn)
        }
    }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Every screen, with the key its root is tagged with.
 *
 * Each screen's root composable carries `testTag("screen_<key>")`, and the
 * whole tree has testTagsAsResourceId on, so a `uiautomator dump` shows
 * `resource-id="screen_home"` and so on. That is how a harness tells which
 * screen it is on without a model, and what defects.json's `screen` means.
 */
sealed interface Screen {
    val key: String

    data object SignIn : Screen { override val key = "sign_in" }
    data object Home : Screen { override val key = "home" }

    /**
     * One plant. `unsaved` is only ever set by PLANTED BG-17: an edit that
     * the screen shows but the garden never stored.
     */
    data class Detail(val id: Int, val unsaved: Plant? = null) : Screen { override val key = "detail" }

    /** Adding (id null) or editing a plant. */
    data class Edit(val id: Int?) : Screen { override val key = "edit" }
    data object Search : Screen { override val key = "search" }
    data object Settings : Screen { override val key = "settings" }
    data object Profile : Screen { override val key = "profile" }
    data class Invite(val plantName: String? = null) : Screen { override val key = "invite" }
    data object About : Screen { override val key = "about" }
}

/** A back stack and a snackbar, which is all the navigation this app needs. */
object Nav {
    val stack = mutableStateListOf<Screen>(Screen.SignIn)
    val top: Screen get() = stack.last()

    /** The message on the sign-in screen after signing out or deleting the account. */
    var signInNotice by mutableStateOf<String?>(null)

    var snack by mutableStateOf<Snack?>(null)
    private var snackSeq = 0

    fun push(s: Screen) { stack.add(s) }

    fun resetTo(s: Screen) {
        stack.clear()
        stack.add(s)
    }

    fun replaceTop(s: Screen) { stack[stack.lastIndex] = s }

    fun toast(message: String) {
        snack = Snack(++snackSeq, message)
    }

    /**
     * Back, from the system button or a screen's back arrow. Returns false
     * when there is nowhere to go, so the activity can close.
     *
     * PLANTED BG-19: with defects on, back from Search goes to the sign-in
     * screen instead of the screen Search was opened from.
     */
    fun back(): Boolean {
        if (Garden.defects && top == Screen.Search) {
            resetTo(Screen.SignIn)
            return true
        }
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }
}

data class Snack(val seq: Int, val message: String)

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

val LocalStrings = staticCompositionLocalOf { stringsFor(Language.EN) }

private val Leaf = Color(0xFF2E7D32)
private val LeafLight = Color(0xFF81C784)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SproutApp() {
    val colors = if (Garden.dark) {
        darkColorScheme(primary = LeafLight, secondary = LeafLight)
    } else {
        lightColorScheme(primary = Leaf, secondary = Leaf)
    }
    val base = LocalDensity.current
    // The in-app text size multiplies whatever the device's own font scale is.
    val density = Density(base.density, base.fontScale * Garden.textSize.scale)
    val snackHost = remember { SnackbarHostState() }
    val snack = Nav.snack

    LaunchedEffect(snack) {
        if (snack != null) snackHost.showSnackbar(snack.message)
    }

    MaterialTheme(colorScheme = colors) {
        CompositionLocalProvider(LocalDensity provides density, LocalStrings provides Garden.strings()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
                    .safeDrawingPadding()
                    .semantics { testTagsAsResourceId = true },
            ) {
                when (val s = Nav.top) {
                    Screen.SignIn -> SignInScreen()
                    Screen.Home -> HomeScreen()
                    is Screen.Detail -> DetailScreen(s)
                    is Screen.Edit -> EditScreen(s)
                    Screen.Search -> SearchScreen()
                    Screen.Settings -> SettingsScreen()
                    Screen.Profile -> ProfileScreen()
                    is Screen.Invite -> InviteScreen(s)
                    Screen.About -> AboutScreen()
                }
                SnackbarHost(snackHost, Modifier.align(Alignment.BottomCenter))
            }
        }
    }

    // Enabled only when back has somewhere to go inside the app; otherwise the
    // system handles it and the activity closes, as a real app's home does.
    BackHandler(enabled = Nav.stack.size > 1 || (Garden.defects && Nav.top == Screen.Search)) {
        Nav.back()
    }
}
