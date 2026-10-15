package dev.fleetrunner.buggarden

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/**
 * The gate. One hard-coded test account, garden@example.test / garden-pass-1,
 * and a guest door for anyone without it. Nothing is checked anywhere else:
 * there is no server.
 */
@Composable
fun SignInScreen() {
    val s = LocalStrings.current
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    fun signIn() {
        if (email.trim().equals(Garden.TEST_EMAIL, ignoreCase = true) && password == Garden.TEST_PASSWORD) {
            Garden.account = Garden.TEST_EMAIL
            Nav.signInNotice = null
            Nav.resetTo(Screen.Home)
        } else {
            error = s.badCredentials
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp)
            .testTag("screen_sign_in"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text(s.appName, style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.primary)
        Text(s.signInTitle, style = MaterialTheme.typography.headlineSmall)
        Text(s.signInBody, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Nav.signInNotice?.let {
            Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("notice"))
        }
        OutlinedTextField(
            value = email,
            onValueChange = { email = it; error = null },
            label = { Text(s.email) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag("field_email"),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it; error = null },
            label = { Text(s.password) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { signIn() }),
            modifier = Modifier.fillMaxWidth().testTag("field_password"),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("error")) }
        Button(onClick = { signIn() }, modifier = Modifier.fillMaxWidth().testTag("button_sign_in")) {
            Text(s.signIn)
        }
        TextButton(
            onClick = {
                Garden.account = null
                Nav.signInNotice = null
                Nav.resetTo(Screen.Home)
            },
            modifier = Modifier.fillMaxWidth().testTag("button_guest"),
        ) {
            Text(s.continueAsGuest)
        }
    }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * The plant list, newest first, with a recently-viewed card and a tip above it.
 *
 * Newest first so a plant someone just added is on screen without scrolling,
 * which is what lets a bench check find it in a single tree dump.
 */
@Composable
fun HomeScreen() {
    val s = LocalStrings.current
    Box(Modifier.fillMaxSize().testTag("screen_home")) {
        Column(Modifier.fillMaxSize()) {
            TopBar(s.myPlants) {
                IconButton(onClick = { Nav.push(Screen.Search) }, modifier = Modifier.testTag("button_search")) {
                    Icon(Icons.Filled.Search, contentDescription = s.search)
                }
                IconButton(onClick = { Nav.push(Screen.Settings) }, modifier = Modifier.testTag("button_settings")) {
                    Icon(Icons.Filled.Settings, contentDescription = s.settings)
                }
                IconButton(onClick = { Nav.push(Screen.Profile) }, modifier = Modifier.testTag("button_profile")) {
                    Icon(Icons.Filled.Person, contentDescription = s.profile)
                }
            }
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                item {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val who = Garden.account
                        Text(
                            if (who != null) s.signedInAs(who) else s.browsingAsGuest,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(s.plantCount(Garden.plants.size), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("plant_count"))
                        RecentCard()
                        TipCard()
                    }
                }
                if (Garden.plants.isEmpty()) {
                    item { Text(s.emptyGarden, Modifier.padding(16.dp)) }
                }
                itemsIndexed(Garden.plants, key = { _, p -> p.id }) { index, p ->
                    PlantRow(p) {
                        Garden.rememberViewed(index)
                        Nav.push(Screen.Detail(p.id))
                    }
                    HorizontalDivider()
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { Nav.push(Screen.Edit(null)) },
            icon = { Icon(Icons.Filled.Add, contentDescription = null) },
            text = { Text(s.addPlant) },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp)
                .testTag("button_add"),
        )
    }
}

@Composable
private fun RecentCard() {
    val s = LocalStrings.current
    val name = Garden.recentName ?: return
    val index = Garden.recentIndex ?: return
    Card(
        Modifier
            .fillMaxWidth()
            .clickable {
                val p = if (Garden.defects) {
                    // PLANTED BG-02: reads the plant by remembered position. After
                    // the last plant in the list is deleted the position is past
                    // the end, and this throws IndexOutOfBoundsException.
                    Garden.plants[index]
                } else {
                    Garden.plants.getOrNull(index) ?: return@clickable
                }
                Nav.push(Screen.Detail(p.id))
            }
            .testTag("card_recent"),
    ) {
        Text(s.recentlyViewed(name), Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun TipCard() {
    val s = LocalStrings.current
    // PLANTED BG-16: mid grey on light grey, a contrast ratio of about 1.4:1
    // (WCAG asks for 4.5:1). Fixed colours, so it is just as bad in dark mode.
    val (container, content) = if (Garden.defects) {
        Color(0xFFBDBDBD) to Color(0xFF9E9E9E)
    } else {
        MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Card(
        Modifier.fillMaxWidth().testTag("card_tip"),
        colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(s.tipOfTheDay, style = MaterialTheme.typography.titleSmall)
            Text(s.tipBody, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** One plant in a list: name, summary, last watered, and a favourite marker. */
@Composable
fun PlantRow(p: Plant, onClick: () -> Unit) {
    val s = LocalStrings.current
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag("plant_row"),
    ) {
        Text(p.name, style = MaterialTheme.typography.titleMedium)
        Text(s.summary(p.quantity, p.location, p.waterEveryDays), style = MaterialTheme.typography.bodyMedium)
        Text(s.watered(p.wateredDaysAgo), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (p.favourite) {
            Text(s.inFavourites, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}
