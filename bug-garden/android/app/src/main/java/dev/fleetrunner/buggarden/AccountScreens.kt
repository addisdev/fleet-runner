package dev.fleetrunner.buggarden

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Dark theme, language, text size, reminders, a local backup and About.
 *
 * Planted here: BG-05 (Back up now blocks the main thread for 8 s), BG-08
 * (the reminders switch flips back), and, through Garden.strings(), BG-12
 * (the German title is a raw key).
 */
@Composable
fun SettingsScreen() {
    val s = LocalStrings.current
    var backedUp by remember { mutableStateOf<Int?>(null) }

    // PLANTED BG-08: with defects on, turning reminders on is undone 400 ms
    // later, as if the setting had been rejected by whatever stores it. The
    // switch moves, then moves back, and the row says "Reminders are off".
    LaunchedEffect(Garden.reminders) {
        if (Garden.defects && Garden.reminders) {
            delay(400)
            Garden.reminders = false
        }
    }

    Column(Modifier.fillMaxSize().testTag("screen_settings")) {
        TopBar(s.settingsTitle, onBack = { Nav.back() })
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            SectionHeading(s.appearance)
            SwitchRow(s.darkTheme, s.darkThemeState(Garden.dark), Garden.dark, "toggle_dark") { Garden.dark = it }

            SectionHeading(s.textSize)
            Text(
                s.textSizeState(s.textSizeName(Garden.textSize)),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("text_size_state"),
            )
            TextSize.entries.forEach { size ->
                OptionRow(s.textSizeName(size), Garden.textSize == size, "option_size_${size.name.lowercase()}") {
                    Garden.textSize = size
                }
            }

            SectionHeading(s.language)
            Text(
                s.languageState(Garden.language.nativeName),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("language_state"),
            )
            // Language names are always written in their own language, so
            // someone who switched by accident can find their way back.
            Language.entries.forEach { lang ->
                OptionRow(lang.nativeName, Garden.language == lang, "option_lang_${lang.code}") {
                    Garden.language = lang
                }
            }

            HorizontalDivider(Modifier.padding(top = 12.dp))
            SwitchRow(s.wateringReminders, s.remindersState(Garden.reminders), Garden.reminders, "toggle_reminders") {
                Garden.reminders = it
            }

            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        // PLANTED BG-05: with defects on, the "backup" runs on the
                        // main thread and takes eight seconds. The app freezes;
                        // a tap during the freeze gets an ANR from the system.
                        if (Garden.defects) Thread.sleep(8_000)
                        backedUp = Garden.plants.size
                    },
                    modifier = Modifier.fillMaxWidth().testTag("button_backup"),
                ) { Text(s.backUpNow) }
                backedUp?.let { Text(s.backedUp(it), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("backup_state")) }
                TextButton(
                    onClick = { Nav.push(Screen.About) },
                    modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("button_about"),
                ) { Text(s.aboutSprout) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * The account: plan, upgrade, invite, sign out, delete.
 *
 * Upgrade, invite and delete are the three controls the explore leash blocks
 * unless a mission allows them. Planted here: BG-10 (the upgrade button
 * clips its label at the largest text size).
 */
@Composable
fun ProfileScreen() {
    val s = LocalStrings.current
    var offerPlus by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().testTag("screen_profile")) {
        TopBar(s.profile, onBack = { Nav.back() })
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val who = Garden.account
            Text(if (who != null) s.signedInAs(who) else s.browsingAsGuest, style = MaterialTheme.typography.bodyLarge)
            Text(
                if (Garden.plus) s.onPlus else s.freePlan,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.testTag("plan_state"),
            )
            if (!Garden.plus) {
                if (Garden.defects) {
                    // PLANTED BG-10: a fixed-width button whose label may not wrap.
                    // The width fits the English label up to the Large text size;
                    // at Largest the label is cut off mid-word.
                    Button(
                        onClick = { offerPlus = true },
                        modifier = Modifier.width(UPGRADE_BUTTON_WIDTH).testTag("button_upgrade"),
                    ) { Text(s.upgrade, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip) }
                } else {
                    Button(
                        onClick = { offerPlus = true },
                        modifier = Modifier.fillMaxWidth().testTag("button_upgrade"),
                    ) { Text(s.upgrade) }
                }
            }
            OutlinedButton(
                onClick = { Nav.push(Screen.Invite()) },
                modifier = Modifier.fillMaxWidth().testTag("button_invite"),
            ) { Text(s.inviteFriend) }
            OutlinedButton(
                onClick = {
                    Garden.signOut()
                    Nav.signInNotice = s.signedOutNotice
                    Nav.resetTo(Screen.SignIn)
                },
                modifier = Modifier.fillMaxWidth().testTag("button_sign_out"),
            ) { Text(s.signOut) }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            TextButton(
                onClick = { confirmDelete = true },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("button_delete_account"),
            ) { Text(s.deleteAccount) }
        }
    }

    if (offerPlus) {
        AlertDialog(
            onDismissRequest = { offerPlus = false },
            title = { Text(s.plusTitle) },
            text = { Text(s.plusBody) },
            confirmButton = {
                TextButton(
                    onClick = { offerPlus = false; Garden.plus = true },
                    modifier = Modifier.testTag("button_buy"),
                ) { Text(s.buy) }
            },
            dismissButton = { TextButton(onClick = { offerPlus = false }) { Text(s.notNow) } },
        )
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(s.deleteAccountTitle) },
            text = { Text(s.deleteAccountBody) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        Garden.deleteAccount()
                        Nav.signInNotice = s.accountDeletedNotice
                        Nav.resetTo(Screen.SignIn)
                    },
                    modifier = Modifier.testTag("button_confirm_delete_account"),
                ) { Text(s.delete) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(s.cancel) } },
        )
    }
}

/** Tuned on a 420 dpi emulator: the English label fits at Large and clips at Largest. */
private val UPGRADE_BUTTON_WIDTH = 220.dp

// ---------------------------------------------------------------------------
// Invite / share
// ---------------------------------------------------------------------------

/**
 * Invite a friend by email, or copy a link. Nothing is actually sent: the
 * screen just says it was. Reached from Profile, and from a plant's Share
 * button, which names the plant.
 *
 * Planted here: BG-06 (blank in German), BG-11 (a raw exception in a snackbar).
 */
@Composable
fun InviteScreen(screen: Screen.Invite) {
    val s = LocalStrings.current
    if (Garden.defects && Garden.language == Language.DE) {
        // PLANTED BG-06: with defects on and the language set to German, the
        // invite screen draws nothing at all: a white page with no text and
        // no controls. Only the system back button gets out.
        Box(Modifier.fillMaxSize().background(Color.White).testTag("screen_invite"))
        return
    }
    val clipboard = LocalClipboardManager.current
    var email by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var sentTo by rememberSaveable { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().testTag("screen_invite")) {
        TopBar(s.inviteFriend, onBack = { Nav.back() })
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            screen.plantName?.let { Text(s.sharePlant(it), style = MaterialTheme.typography.titleMedium) }
            Text(s.inviteBody, style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(
                value = email,
                onValueChange = { email = it; error = null },
                label = { Text(s.friendsEmail) },
                singleLine = true,
                isError = error != null,
                supportingText = error?.let { e -> @Composable { Text(e) } },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth().testTag("field_invite_email"),
            )
            Button(
                onClick = {
                    val e = email.trim()
                    if (Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").matches(e)) {
                        sentTo = e
                        email = ""
                    } else {
                        error = s.invalidEmail
                    }
                },
                modifier = Modifier.fillMaxWidth().testTag("button_send_invite"),
            ) { Text(s.sendInvite) }
            sentTo?.let {
                Text(s.inviteSent(it), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("invite_state"))
            }
            OutlinedButton(
                onClick = {
                    try {
                        // PLANTED BG-11: with defects on, the link is never built,
                        // and the failure goes straight to the user as the raw
                        // exception text: "java.lang.IllegalStateException: null".
                        val link = if (Garden.defects) null else "https://sprout.example/invite/garden"
                        clipboard.setText(AnnotatedString(link ?: throw IllegalStateException()))
                        Nav.toast(s.linkCopied)
                    } catch (e: IllegalStateException) {
                        Nav.toast("${e.javaClass.name}: ${e.message}")
                    }
                },
                modifier = Modifier.fillMaxWidth().testTag("button_copy_link"),
            ) { Text(s.copyLink) }
        }
    }
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

/** Name, version, a paragraph of story. Planted here: BG-13 (placeholder copy). */
@Composable
fun AboutScreen() {
    val s = LocalStrings.current
    Column(Modifier.fillMaxSize().testTag("screen_about")) {
        TopBar(s.about, onBack = { Nav.back() })
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(s.appName, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(s.version(BuildInfo.VERSION), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("version"))
            SectionHeading(s.ourStory)
            Text(
                // PLANTED BG-13: with defects on, the story is still the
                // designer's placeholder, in every language.
                if (Garden.defects) LOREM else s.aboutBody,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("about_body"),
            )
            Text(s.privacyLine, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private const val LOREM =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."

object BuildInfo {
    const val VERSION = "1.0.0"
}
