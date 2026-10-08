import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Pocket Pair's bar entry point: one quiet glyph that turns the theme accent
// once a phone is paired, and the nested panel that holds everything else.
//
// The panel is loaded from this file rather than declared as a second plugin
// kind, which is how a bar widget with a details popup is built. The glyph
// carries the widget's lifecycle contract so `omarchy-shell shell
// summon|hide|toggle ribattrw.pocket-pair` reaches the loaded panel.

BarWidget {
  id: root
  moduleName: "ribattrw.pocket-pair"

  // One engine per widget instance; the bar surface exists per monitor and the
  // paired state must be known while the panel is closed.
  property Engine engine: Engine {
    host: root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  function toggle() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch)
      panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.GLYPHS.phone
    // Paired reads as the theme accent; everything else stays the bar's own
    // foreground, so an unpaired bar carries no extra colour.
    active: root.engine.paired
    activeColor: Color.accent
    tooltipText: ""

    onPressed: function(code) { root.toggle() }
  }
}
