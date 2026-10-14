import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Pocket Pair's panel. It never asks the user to pick a step: it runs the
// checks itself, and shows the one button that moves things forward — Install
// helper, then one terminal for whatever needs root, then Show QR. Once a
// phone is paired it shrinks to the paired status and the list of phones.
//
// The main page stays short: a hero header, the checks as status chips, and
// the current step in a title and one sentence above its button. Everything
// longer (the steps that run, why, how to undo) is on the Details page,
// word for word, and the main page still says when a step asks for sudo.
//
// Loaded by BarWidget.qml, not declared as a second plugin kind. It owns no
// state: everything comes from the engine on the bar widget.

Panel {
  id: root
  moduleName: "ribattrw.pocket-pair"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var engine: hostWidget ? hostWidget.engine : null

  readonly property color textColor: root.barForeground
  // Secondary text, as PanelHero and PanelSectionHeader dim it: readable on
  // the panel background, unlike Color.muted, which stays for small captions.
  readonly property color dimColor: Qt.darker(textColor, 1.4)
  readonly property string pairState: engine ? engine.pairState : "idle"
  readonly property bool showingQr: pairState === "waiting" && engine && engine.qrSize > 0
  readonly property var step: engine ? engine.step : ({ kind: "wait", label: "Check again" })
  readonly property bool ready: step.kind === "pair" || step.kind === "done"
  // A pairing result replaces the setup view until the user dismisses it.
  readonly property bool resultView: pairState === "ready" || pairState === "error" || pairState === "expired"
  // The view for the current step: everything except the QR, a starting
  // session and a pairing result.
  readonly property bool setupView: !!engine && !resultView && !showingQr && pairState !== "starting"

  readonly property string mode: engine && engine.lanMode ? "lan" : "tailscale"
  readonly property var summary: engine ? Model.stepSummary(step, engine.checks, mode) : ({ title: "", glyph: "", line: "" })
  readonly property var details: engine ? Model.stepDetails(step, engine.checks, mode)
    : ({ runs: [], sudo: false, whyTitle: "", why: [], undo: "" })
  readonly property bool hasDetails: details.runs.length > 0 || details.why.length > 0
  readonly property int todoCount: engine && engine.checked
    ? engine.checklist.filter(function(row) { return row.state !== "ok" }).length : 0

  // The Details page replaces the main page until Back. A new step closes
  // it, so it never shows the steps of something that already happened.
  property bool detailsOpen: false
  readonly property bool showingDetails: detailsOpen && setupView && hasDetails
  readonly property string stepKey: step.kind + ":" + step.label
  onStepKeyChanged: detailsOpen = false
  onShowingDetailsChanged: panelFlick.contentY = 0

  property string confirmRevokeId: ""
  property bool confirmSwitch: false

  onOpenedChanged: {
    if (!engine) return
    engine.panelOpen = opened
    if (opened) {
      engine.refresh()
    } else {
      // Close always cancels a session: the link must not outlive the view.
      engine.dismissPair()
      confirmRevokeId = ""
      detailsOpen = false
    }
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function primary() {
    if (!engine) return
    if (resultView) { engine.dismissPair(); return }
    if (showingQr || pairState === "starting") { engine.cancelPair(); return }
    if (engine.busy) return
    switch (step.kind) {
      case "install": engine.installHelper(); break
      case "fix": engine.runFixes(); break
      case "pair":
      case "done": engine.startPair(); break
      default: engine.refresh()
    }
  }

  // One check as a small bordered pill: its state as a glyph, then a short
  // label. Built the way PanelHero builds its own detail pill. Anything not
  // done is filled, so what is left stands out.
  component StatusChip: BorderSurface {
    id: chip
    property string glyph: ""
    property string label: ""
    property bool done: true
    property color foreground: Color.foreground
    readonly property color ink: done ? Qt.darker(foreground, 1.4) : foreground
    implicitWidth: chipRow.implicitWidth + Style.space(12)
    implicitHeight: chipRow.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: done ? "transparent" : Style.hoverFillFor(foreground, Color.accent)
    borderSpec: Border.controlSpec(done ? "hover-cursor" : "normal", foreground, Color.accent)

    Row {
      id: chipRow
      anchors.centerIn: parent
      spacing: Style.space(5)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: chip.glyph
        color: chip.ink
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: chip.label
        color: chip.ink
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(760))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Esc and Left leave the Details page first; Right opens it.
      onCloseRequested: {
        if (root.showingDetails) root.detailsOpen = false
        else root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onActivateRequested: root.primary()
      onMoveRequested: function(dx, dy) {
        if (dx > 0 && root.setupView && root.hasDetails) root.detailsOpen = true
        if (dx < 0) root.detailsOpen = false
        if (dy !== 0)
          panelFlick.contentY = Math.max(0, Math.min(panelFlick.contentHeight - panelFlick.height,
                                                     panelFlick.contentY + dy * Style.space(56)))
      }

      // The card is capped to the screen, so whatever does not fit scrolls
      // inside it (clipped) instead of drawing past the card's edge.
      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: content
          width: panelFlick.width
          spacing: Style.spacing.xl

          // --------------------------------------------------------- hero
          PanelHero {
            visible: !root.showingDetails
            width: parent.width
            title: "Pocket Pair"
            meta: root.engine ? Model.networkLine(root.engine.checks, root.mode) : ""
            detail: !root.engine || !root.engine.checked ? ""
              : root.pairState === "waiting" ? "waiting"
              : !root.ready ? (root.todoCount > 0 ? root.todoCount + " to do" : "setup")
              : root.engine.paired ? root.engine.hosts.length + " paired" : "ready"
            foreground: root.textColor
            iconOpacity: root.engine && root.engine.paired ? 1.0 : 0.6
            iconComponent: Component {
              Text {
                text: Model.GLYPHS.phone
                color: root.engine && root.engine.paired ? Color.accent : root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.display
                textFormat: Text.PlainText
              }
            }
          }

          // ------------------------------------------------------- chips
          // Shown only while something is missing; once everything is ready
          // the hero says so instead.
          Flow {
            visible: root.setupView && !root.showingDetails && !root.ready
              && !!root.engine && root.engine.checked
            width: parent.width
            spacing: Style.spacing.md

            Repeater {
              model: root.engine && root.engine.checked ? root.engine.checklist : []

              delegate: StatusChip {
                required property var modelData
                foreground: root.textColor
                done: modelData.state === "ok"
                glyph: modelData.state === "ok" ? Model.GLYPHS.check
                  : modelData.state === "wait" ? Model.GLYPHS.circle : Model.GLYPHS.cross
                label: modelData.chip
              }
            }
          }

          PanelSeparator {
            visible: root.setupView && !root.showingDetails && !root.ready
              && !!root.engine && root.engine.checked
            width: parent.width
            foreground: root.textColor
          }

          // ------------------------------------------------- QR (waiting)
          Column {
            visible: root.showingQr
            width: parent.width
            spacing: Style.spacing.lg

            // Integer-sized native rectangles, as the Wi-Fi share card does:
            // crisp, and no temporary image file ever holds the pairing link.
            Rectangle {
              id: qrCanvas
              readonly property int size: root.engine ? root.engine.qrSize : 0
              readonly property int moduleSize: size > 0
                ? Math.max(3, Math.floor(Style.space(220) / size)) : 0
              anchors.horizontalCenter: parent.horizontalCenter
              width: size * moduleSize
              height: width
              color: "white"
              radius: Style.cornerRadius

              Grid {
                anchors.fill: parent
                columns: qrCanvas.size

                Repeater {
                  model: qrCanvas.size * qrCanvas.size

                  Rectangle {
                    required property int index
                    width: qrCanvas.moduleSize
                    height: qrCanvas.moduleSize
                    color: root.engine && root.engine.qrRows[Math.floor(index / qrCanvas.size)]
                      .charAt(index % qrCanvas.size) === "1" ? "#111111" : "transparent"
                  }
                }
              }
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              text: "Scan with the Moshi app"
              color: root.textColor
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              textFormat: Text.PlainText
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.Wrap
              text: "expires in " + Model.formatCountdown(root.engine ? root.engine.secondsLeft : 0)
                + "\nanyone who scans this gets access, so keep it off screen shares"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }
          }

          // ------------------------------------------- starting / result
          Text {
            visible: root.pairState === "starting"
            width: parent.width
            text: "Starting a pairing session…"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            textFormat: Text.PlainText
          }

          Text {
            visible: root.pairState === "ready"
            width: parent.width
            wrapMode: Text.Wrap
            text: root.engine && root.engine.lanMode ? "Paired. Your phone can now connect while it is on this Wi-Fi."
              : "Paired. Your phone can now connect over Tailscale."
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            textFormat: Text.PlainText
          }

          Text {
            visible: root.pairState === "expired"
            width: parent.width
            wrapMode: Text.Wrap
            text: "The code expired. Nothing was paired."
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            textFormat: Text.PlainText
          }

          Text {
            visible: root.pairState === "error"
            width: parent.width
            wrapMode: Text.Wrap
            text: root.engine ? root.engine.pairError : ""
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }

          // ------------------------------------------------ current step
          Column {
            visible: root.setupView && !root.showingDetails && root.step.kind !== "done"
              && !!root.engine && root.engine.checked
            width: parent.width
            spacing: Style.spacing.md

            Item {
              width: parent.width
              height: stepTitle.implicitHeight

              Text {
                id: stepGlyph
                width: Style.space(20)
                anchors.verticalCenter: stepTitle.verticalCenter
                text: root.summary.glyph
                color: Color.accent
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                textFormat: Text.PlainText
              }

              Text {
                id: stepTitle
                anchors.left: stepGlyph.right
                anchors.leftMargin: Style.spacing.md
                anchors.right: parent.right
                wrapMode: Text.Wrap
                text: root.summary.title
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.subtitle
                font.bold: true
                textFormat: Text.PlainText
              }
            }

            Text {
              visible: text !== ""
              width: parent.width
              wrapMode: Text.Wrap
              text: root.summary.line
              color: root.dimColor
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              textFormat: Text.PlainText
            }

            Text {
              visible: root.engine && root.engine.installError !== ""
              width: parent.width
              wrapMode: Text.Wrap
              text: root.engine ? root.engine.installError : ""
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              textFormat: Text.PlainText
            }
          }

          // ------------------------------------------------- details page
          Column {
            visible: root.showingDetails
            width: parent.width
            spacing: Style.spacing.xl

            Item {
              width: parent.width
              height: backButton.implicitHeight

              Button {
                id: backButton
                anchors.left: parent.left
                iconText: Model.GLYPHS.back
                text: "Back"
                fontSize: Style.font.caption
                foreground: root.textColor
                onClicked: root.detailsOpen = false
              }

              Text {
                anchors.left: backButton.right
                anchors.leftMargin: Style.spacing.lg
                anchors.right: parent.right
                anchors.verticalCenter: backButton.verticalCenter
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
                text: root.summary.title
                color: root.dimColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                textFormat: Text.PlainText
              }
            }

            Column {
              visible: root.details.runs.length > 0
              width: parent.width
              spacing: Style.spacing.sm

              PanelSectionHeader { text: "WHAT RUNS"; foreground: root.textColor }

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "A terminal opens, shows these steps, then asks for your password:"
                color: root.dimColor
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                textFormat: Text.PlainText
              }

              Repeater {
                model: root.details.runs

                delegate: Text {
                  required property string modelData
                  width: parent ? parent.width : 0
                  wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                  text: modelData
                  color: root.textColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  textFormat: Text.PlainText
                }
              }
            }

            PanelSeparator {
              visible: root.details.runs.length > 0 && root.details.why.length > 0
              width: parent.width
              foreground: root.textColor
            }

            Column {
              visible: root.details.why.length > 0
              width: parent.width
              spacing: Style.spacing.sm

              PanelSectionHeader { text: root.details.whyTitle; foreground: root.textColor }

              Repeater {
                model: root.details.why

                delegate: Text {
                  required property string modelData
                  width: parent ? parent.width : 0
                  wrapMode: Text.Wrap
                  text: modelData
                  color: root.dimColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  textFormat: Text.PlainText
                }
              }

              Text {
                visible: root.details.undo !== ""
                width: parent.width
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                text: root.details.undo
                color: root.dimColor
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                textFormat: Text.PlainText
              }
            }
          }

          // --------------------------------------------- primary button
          // One button for both pages, so Details always ends in the action.
          Button {
            id: primaryButton
            width: parent.width
            visible: root.engine !== null
            bordered: true
            foreground: Color.accent
            focusable: true
            // A lock when the step's terminal asks for sudo.
            iconText: root.setupView && root.details.sudo && !(root.engine && root.engine.installLine !== "")
              ? Model.GLYPHS.lock : ""
            text: root.resultView ? (root.pairState === "ready" ? "Done" : "Try again")
              : root.showingQr || root.pairState === "starting" ? "Cancel"
              : root.engine && root.engine.installLine !== "" ? root.engine.installLine
              : root.step.label
            enabled: !(root.engine && root.engine.installLine !== "")
            opacity: enabled ? 1 : 0.6
            onClicked: {
              if (root.pairState === "error" || root.pairState === "expired") {
                root.engine.dismissPair()
                if (root.step.kind === "pair" || root.step.kind === "done") root.engine.startPair()
              } else root.primary()
            }
          }

          // What the button runs, and the way to Details. The sudo note
          // stays here even while Details is closed.
          Item {
            visible: root.setupView && !root.showingDetails && root.hasDetails
            width: parent.width
            height: detailsLink.implicitHeight

            Text {
              anchors.left: parent.left
              anchors.right: detailsLink.left
              anchors.rightMargin: Style.spacing.lg
              elide: Text.ElideRight
              text: root.details.runs.length === 0 ? ""
                : (root.details.sudo ? "asks for sudo \u00b7 " : "") + root.details.runs.length
                  + (root.details.runs.length === 1 ? " step" : " steps")
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }

            Text {
              id: detailsLink
              anchors.right: parent.right
              text: "Details " + Model.GLYPHS.next
              color: root.dimColor
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.underline: true
              textFormat: Text.PlainText

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.detailsOpen = true
              }
            }
          }

          // ------------------------------------------- network choice
          // Tailscale stays the recommended path; the home network is offered
          // quietly while Tailscale is missing or signed out, and in home-network
          // mode there is always a way back.
          Text {
            readonly property bool offerLan: !!root.engine && !root.engine.lanMode && root.step.alt !== undefined
            readonly property bool offerTailscale: !!root.engine && root.engine.lanMode
            visible: (offerLan || offerTailscale) && !root.showingQr && root.pairState !== "starting"
              && !root.showingDetails
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: offerLan ? root.step.alt.label : "Use Tailscale instead (recommended)"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.underline: networkHover.containsMouse
            textFormat: Text.PlainText

            MouseArea {
              id: networkHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: if (root.engine) {
                root.engine.dismissPair()
                if (root.engine.lanMode && root.engine.canCloseFirewall) root.confirmSwitch = true
                else root.engine.setNetwork(root.engine.lanMode ? "tailscale" : "lan")
              }
            }
          }

          Column {
            visible: root.confirmSwitch && !!root.engine && root.engine.canCloseFirewall && root.engine.lanMode
              && !root.showingDetails
            width: parent.width
            spacing: 4

            Text {
              width: parent.width
              wrapMode: Text.Wrap
              text: "The firewall is still open to " + (root.engine ? root.engine.checks.openSubnets.join(", ") : "")
                + ". Close it before switching?"
              color: root.dimColor
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              textFormat: Text.PlainText
            }

            Repeater {
              model: [
                { label: "Close the firewall, then switch", close: true },
                { label: "Switch and leave it open", close: false }
              ]

              delegate: Text {
                required property var modelData
                width: parent ? parent.width : 0
                text: modelData.label
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.underline: choiceHover.containsMouse
                textFormat: Text.PlainText

                MouseArea {
                  id: choiceHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: if (root.engine) {
                    root.confirmSwitch = false
                    if (modelData.close) root.engine.closeFirewall()
                    root.engine.setNetwork("tailscale")
                  }
                }
              }
            }
          }

          // ------------------------------------------------- paired phones
          Column {
            visible: root.engine && root.engine.paired && !root.showingQr && root.pairState !== "starting"
              && !root.showingDetails
            width: parent.width
            spacing: Style.spacing.md

            PanelSeparator { width: parent.width }

            PanelSectionHeader { text: "PAIRED PHONES" }

            Repeater {
              model: root.engine ? root.engine.hosts : []

              delegate: Item {
                id: hostRow
                required property var modelData
                width: parent ? parent.width : 0
                height: Math.max(hostLabel.implicitHeight, Style.space(22))
                readonly property bool confirming: root.confirmRevokeId === hostRow.modelData.id

                Text {
                  id: hostLabel
                  anchors.left: parent.left
                  anchors.right: revokeButton.left
                  anchors.rightMargin: Style.spacing.lg
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideMiddle
                  text: hostRow.confirming ? "Revoke this key?" : hostRow.modelData.target
                  color: hostRow.confirming ? Color.urgent : root.textColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  textFormat: Text.PlainText
                }

                PanelActionButton {
                  id: revokeButton
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: hostRow.confirming ? "" : ""
                  tooltipText: hostRow.confirming ? "Confirm revoke" : "Revoke access"
                  foreground: root.textColor
                  hoverColor: Color.urgent
                  onClicked: {
                    if (hostRow.confirming) {
                      root.confirmRevokeId = ""
                      root.engine.revoke(hostRow.modelData.id)
                    } else {
                      root.confirmRevokeId = hostRow.modelData.id
                    }
                  }
                }
              }
            }

            Text {
              visible: root.engine && root.engine.revokeError !== ""
              width: parent.width
              wrapMode: Text.Wrap
              text: root.engine ? root.engine.revokeError : ""
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }
          }

          // ----------------------------------------------------- footer
          Item {
            visible: root.engine && root.engine.checked && root.engine.checks.hook.present
              && !root.showingQr && root.pairState !== "starting" && !root.showingDetails
            width: parent.width
            height: footerVersion.implicitHeight

            Text {
              id: footerVersion
              anchors.left: parent.left
              text: root.engine ? "moshi-hook " + root.engine.checks.hook.version
                + (root.engine.checks.daemon ? "" : " \u00b7 not running") : ""
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }

            Text {
              anchors.right: parent.right
              visible: root.engine && root.engine.checks.hook.outdated
              text: root.engine && root.engine.busy ? "updating…" : "update to " + (root.engine ? root.engine.checks.hook.latest : "")
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: if (root.engine) root.engine.updateHelper()
              }
            }
          }

          Text {
            visible: root.engine && root.engine.canCloseFirewall && !root.confirmSwitch && !root.showingQr
              && root.pairState !== "starting" && !root.showingDetails
            width: parent.width
            text: "close the firewall again"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.underline: closeHover.containsMouse
            textFormat: Text.PlainText

            MouseArea {
              id: closeHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: if (root.engine) root.engine.closeFirewall()
            }
          }
        }
      }
    }
  }
}
