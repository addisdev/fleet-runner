package dev.fleetrunner.buggarden

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

@Composable
fun DetailScreen(screen: Screen.Detail) {
    val s = LocalStrings.current
    // An unsaved edit (PLANTED BG-17) wins over the stored plant while this
    // screen is open; leaving and coming back shows the stored one again.
    val p = screen.unsaved ?: Garden.plant(screen.id)
    if (p == null) {
        // Deleted from under us; go back rather than draw a plant that isn't there.
        LaunchedEffect(screen) { Nav.back() }
        return
    }
    var confirmDelete by remember { mutableStateOf(false) }

    /** Change the plant, in the garden and in any unsaved copy this screen shows. */
    fun change(f: (Plant) -> Plant) {
        Garden.plant(p.id)?.let { Garden.updatePlant(f(it)) }
        screen.unsaved?.let { Nav.replaceTop(screen.copy(unsaved = f(it))) }
    }

    Column(Modifier.fillMaxSize().testTag("screen_detail")) {
        TopBar(p.name, onBack = { Nav.back() }) {
            IconButton(
                onClick = { change { it.copy(favourite = !it.favourite) } },
                modifier = Modifier.testTag("button_favourite"),
            ) {
                Icon(
                    if (p.favourite) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    // PLANTED BG-14: with defects on, the favourite button has no
                    // content description, so a screen reader announces only
                    // "button" and the tree shows a tappable with no label.
                    contentDescription = if (Garden.defects) null
                    else if (p.favourite) s.removeFromFavourites else s.addToFavourites,
                )
            }
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(s.summary(p.quantity, p.location, p.waterEveryDays), style = MaterialTheme.typography.bodyLarge)
            Text(s.watered(p.wateredDaysAgo), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (p.favourite) {
                Text(s.inFavourites, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            InfoRow(s.species, p.species.ifBlank { "—" })
            InfoRow(s.location, p.location.ifBlank { "—" })
            InfoRow(s.quantity, p.quantity.toString())
            InfoRow(s.waterEvery, s.days(p.waterEveryDays))
            InfoRow(s.lastWatered, s.watered(p.wateredDaysAgo))
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text(s.notes, style = MaterialTheme.typography.titleSmall)
            Text(p.notes.ifBlank { "—" }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("notes"))
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        // PLANTED BG-07: with defects on, Water now does nothing at
                        // all: no change on screen, no message, nothing stored.
                        if (!Garden.defects) change { it.copy(wateredDaysAgo = 0) }
                    },
                    modifier = Modifier.weight(1f).testTag("button_water"),
                ) { Text(s.waterNow) }
                OutlinedButton(
                    onClick = { Nav.push(Screen.Edit(p.id)) },
                    modifier = Modifier.weight(1f).testTag("button_edit"),
                ) { Text(s.edit) }
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 24.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { Nav.push(Screen.Invite(p.name)) },
                    modifier = Modifier.weight(1f).testTag("button_share"),
                ) { Text(s.share) }
                OutlinedButton(
                    onClick = { confirmDelete = true },
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.weight(1f).testTag("button_delete"),
                ) { Text(s.delete) }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(s.deletePlantTitle(p.name)) },
            text = { Text(s.cannotBeUndone) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        Garden.deletePlant(p.id)
                        Nav.back()
                        Nav.toast(s.deletedPlant(p.name))
                    },
                    modifier = Modifier.testTag("button_confirm_delete"),
                ) { Text(s.delete) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(s.cancel) }
            },
        )
    }
}

/** A label and its value, side by side. */
@Composable
private fun InfoRow(label: String, value: String) {
    if (Garden.defects && Garden.language == Language.ES) {
        // PLANTED BG-09: the Spanish layout puts the value at a fixed offset
        // that was measured against the English labels. Every Spanish label is
        // longer than the gap, so label and value are drawn on top of each
        // other.
        Box(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false)
            Text(value, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 104.dp))
        }
    } else {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.42f))
            Text(value, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(0.58f))
        }
    }
}

// ---------------------------------------------------------------------------
// Add / edit
// ---------------------------------------------------------------------------

/**
 * The plant form, for a new plant (id null) or an existing one.
 *
 * Three planted defects are in Save, in the order they can fire:
 *   BG-03  a quantity that is not a whole number crashes (NumberFormatException)
 *   BG-01  a blank species crashes (NullPointerException)
 *   BG-17  saving an edit says "Saved" and keeps nothing
 */
@Composable
fun EditScreen(screen: Screen.Edit) {
    val s = LocalStrings.current
    // When editing, start from what the detail screen underneath is showing,
    // which is the unsaved copy if BG-17 made one.
    val below = Nav.stack.getOrNull(Nav.stack.lastIndex - 1) as? Screen.Detail
    val existing = screen.id?.let { below?.unsaved ?: Garden.plant(it) }

    var name by rememberSaveable { mutableStateOf(existing?.name ?: "") }
    var species by rememberSaveable { mutableStateOf(existing?.species ?: "") }
    var quantity by rememberSaveable { mutableStateOf(existing?.quantity?.toString() ?: "1") }
    var location by rememberSaveable { mutableStateOf(existing?.location ?: "") }
    var every by rememberSaveable { mutableStateOf(existing?.waterEveryDays?.toString() ?: "7") }
    var notes by rememberSaveable { mutableStateOf(existing?.notes ?: "") }
    var nameError by rememberSaveable { mutableStateOf<String?>(null) }
    var quantityError by rememberSaveable { mutableStateOf<String?>(null) }
    var everyError by rememberSaveable { mutableStateOf<String?>(null) }

    fun save() {
        nameError = if (name.isBlank()) s.nameRequired else null
        val qty: Int? = when {
            quantity.isBlank() -> { quantityError = s.quantityRequired; null }
            // PLANTED BG-03: with defects on, the quantity is parsed with no
            // check at all, and the field's keyboard offers a decimal point.
            // "2.5" (or any non-integer) throws NumberFormatException.
            Garden.defects -> { quantityError = null; quantity.trim().toInt() }
            else -> quantity.trim().toIntOrNull()?.takeIf { it in 1..999 }
                .also { quantityError = if (it == null) s.quantityWhole else null }
        }
        val days = every.trim().toIntOrNull()?.takeIf { it in 1..60 }
        everyError = if (days == null) s.daysRange else null
        if (nameError != null || qty == null || days == null) return

        val speciesGiven = species.trim().ifBlank { null }
        // PLANTED BG-01: with defects on, the species is treated as if it were
        // required, though the form labels it optional. A blank species throws
        // NullPointerException here.
        val speciesText = if (Garden.defects) speciesGiven!!.replaceFirstChar { it.uppercase() } else speciesGiven.orEmpty()

        val edited = Plant(
            id = existing?.id ?: 0,
            name = name.trim(),
            species = speciesText,
            location = location.trim(),
            quantity = qty,
            waterEveryDays = days,
            wateredDaysAgo = existing?.wateredDaysAgo ?: 0,
            notes = notes.trim(),
            favourite = existing?.favourite ?: false,
        )
        when {
            existing == null -> {
                Garden.addPlant(edited)
                Nav.back()
            }
            Garden.defects -> {
                // PLANTED BG-17: the edit is handed to the detail screen to show,
                // and never written to the garden. The detail screen looks right
                // until you leave it; the list never changes at all.
                Nav.back()
                (Nav.top as? Screen.Detail)?.let { Nav.replaceTop(it.copy(unsaved = edited)) }
            }
            else -> {
                Garden.updatePlant(edited)
                Nav.back()
            }
        }
        Nav.toast(s.saved)
    }

    Column(Modifier.fillMaxSize().testTag("screen_edit")) {
        TopBar(if (existing == null) s.addPlant else s.editPlant, onBack = { Nav.back() })
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FormField(s.name, name, "field_name", nameError) { name = it; nameError = null }
            FormField(s.speciesOptional, species, "field_species") { species = it }
            FormField(s.quantity, quantity, "field_quantity", quantityError, KeyboardType.Decimal) { quantity = it; quantityError = null }
            FormField(s.locationOptional, location, "field_location") { location = it }
            FormField(s.waterEveryDays, every, "field_every", everyError, KeyboardType.Number) { every = it; everyError = null }
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it },
                label = { Text(s.notesOptional) },
                minLines = 2,
                modifier = Modifier.fillMaxWidth().testTag("field_notes"),
            )
            Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { Nav.back() }, modifier = Modifier.weight(1f).testTag("button_cancel")) { Text(s.cancel) }
                Button(onClick = { save() }, modifier = Modifier.weight(1f).testTag("button_save")) { Text(s.save) }
            }
        }
    }
}

@Composable
private fun FormField(
    label: String,
    value: String,
    tag: String,
    error: String? = null,
    keyboard: KeyboardType = KeyboardType.Text,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { e -> @Composable { Text(e) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth().testTag(tag),
    )
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search by name. Runs when Search (the button or the keyboard key) is pressed,
 * not on every keystroke, so "three searches" means three presses.
 *
 * Planted here or in Garden.search: BG-04 (third miss in a row crashes),
 * BG-15 (20dp clear button), BG-18 (case-sensitive), BG-19 (back goes to
 * sign-in, in Nav.back).
 */
@Composable
fun SearchScreen() {
    val s = LocalStrings.current
    var query by rememberSaveable { mutableStateOf("") }
    var searched by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<Plant>>(emptyList()) }

    fun run() {
        results = Garden.search(query)
        searched = query.trim()
    }

    val clear: (@Composable () -> Unit)? = if (query.isEmpty()) null else {
        { ClearButton { query = "" } }
    }

    Column(Modifier.fillMaxSize().testTag("screen_search")) {
        TopBar(s.search, onBack = { Nav.back() })
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text(s.searchPlants) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { run() }),
                trailingIcon = clear,
                modifier = Modifier.weight(1f).testTag("field_search"),
            )
            Button(onClick = { run() }, modifier = Modifier.testTag("button_run_search")) { Text(s.search) }
        }
        val done = searched
        if (done != null) {
            Text(
                if (results.isEmpty()) s.noMatches(done) else s.results(results.size),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(16.dp).testTag("search_summary"),
            )
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(results, key = { it.id }) { p ->
                PlantRow(p) { Nav.push(Screen.Detail(p.id)) }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun ClearButton(onClick: () -> Unit) {
    val s = LocalStrings.current
    if (Garden.defects) {
        // PLANTED BG-15: a bare clickable icon, 20dp square, with no minimum
        // touch target. It has a label; it is just too small to hit (48dp is
        // the Android guideline).
        Box(
            Modifier
                .size(20.dp)
                .clickable(onClick = onClick)
                .testTag("button_clear_search"),
        ) {
            Icon(Icons.Filled.Clear, contentDescription = s.clearSearch, modifier = Modifier.size(20.dp))
        }
    } else {
        IconButton(onClick = onClick, modifier = Modifier.testTag("button_clear_search")) {
            Icon(Icons.Filled.Clear, contentDescription = s.clearSearch)
        }
    }
}
