import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Pocket Pair's panel. It never asks the user to pick a step: it runs the
// checks itself, and shows the one button that moves things forward — Install
// helper, then one terminal for whatever needs root, then Show QR. Once a
// phone is paired it shrinks to the paired status and the list of phones.
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
  readonly property string pairState: engine ? engine.pairState : "idle"
  readonly property bool showingQr: pairState === "waiting" && engine && engine.qrSize > 0
  readonly property var step: engine ? engine.step : ({ kind: "wait", label: "Check again" })
  readonly property bool ready: step.kind === "pair" || step.kind === "done"
  // A pairing result replaces the setup view until the user dismisses it.
  readonly property bool resultView: pairState === "ready" || pairState === "error" || pairState === "expired"

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

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onActivateRequested: root.primary()

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.xl

        // ------------------------------------------------------- header
        Item {
          width: parent.width
          height: title.implicitHeight

          Text {
            id: title
            anchors.left: parent.left
            text: "POCKET PAIR"
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1
            textFormat: Text.PlainText
          }

          Text {
            anchors.right: parent.right
            text: root.pairState === "waiting" ? "waiting for your phone"
              : !root.ready ? "needs setup"
              : root.engine && root.engine.paired ? "paired" : "ready"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }
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

        // ------------------------------------------------- checklist
        // Shown only while something is missing; once everything is ready
        // the panel says so in one line instead.
        Column {
          visible: !root.resultView && !root.showingQr && root.pairState !== "starting" && !root.ready
          width: parent.width
          spacing: Style.spacing.md

          Repeater {
            model: root.engine && root.engine.checked ? root.engine.checklist : []

            delegate: Item {
              id: row
              required property var modelData
              width: parent ? parent.width : 0
              height: Math.max(rowLabel.implicitHeight, rowDetail.implicitHeight)

              Text {
                id: dot
                anchors.left: parent.left
                anchors.verticalCenter: rowLabel.verticalCenter
                text: row.modelData.state === "ok" ? Model.GLYPHS.ok
                  : row.modelData.state === "wait" ? Model.GLYPHS.wait : Model.GLYPHS.todo
                color: row.modelData.state === "ok" ? Color.accent : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                textFormat: Text.PlainText
              }

              Text {
                id: rowLabel
                anchors.left: dot.right
                anchors.leftMargin: Style.spacing.lg
                text: row.modelData.label
                color: row.modelData.state === "ok" ? Color.muted : root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                textFormat: Text.PlainText
              }

              Text {
                id: rowDetail
                anchors.right: parent.right
                anchors.left: rowLabel.right
                anchors.leftMargin: Style.spacing.lg
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
                text: row.modelData.detail
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                textFormat: Text.PlainText
              }
            }
          }

          Text {
            visible: root.step.hint !== undefined
            width: parent.width
            wrapMode: Text.Wrap
            text: root.step.hint || ""
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }

          Column {
            visible: root.step.kind === "fix"
            width: parent.width
            spacing: Style.spacing.xs

            Text {
              width: parent.width
              wrapMode: Text.Wrap
              text: "A terminal opens, shows these commands, then asks for your password:"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              textFormat: Text.PlainText
            }

            Repeater {
              model: root.step.fixes || []

              delegate: Text {
                required property var modelData
                width: parent ? parent.width : 0
                wrapMode: Text.WrapAnywhere
                text: "$ " + modelData.cmd
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                textFormat: Text.PlainText
              }
            }
          }

          Text {
            visible: root.engine && root.engine.lanMode
            width: parent.width
            wrapMode: Text.Wrap
            text: "Home network works on the same Wi-Fi only. It opens SSH to your local network only"
              + (root.engine && root.engine.checks.lan.ok ? " (" + root.engine.checks.lan.subnet + ")" : "")
              + ", never to everyone, and only once SSH accepts keys only (never passwords). For access from anywhere, use Tailscale."
            color: Color.muted
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

        Text {
          visible: !root.resultView && !root.showingQr && root.pairState !== "starting"
            && root.step.kind === "pair"
          width: parent.width
          wrapMode: Text.Wrap
          text: root.engine && root.engine.lanMode
            ? "Everything is ready: SSH accepts keys only. Put your phone on this Wi-Fi, open Moshi, then show the code."
            : "Everything is ready. Open Moshi on your phone, then show the code."
          color: root.textColor
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          textFormat: Text.PlainText
        }

        // --------------------------------------------- primary button
        Button {
          id: primaryButton
          width: parent.width
          visible: root.engine !== null
          bordered: true
          foreground: Color.accent
          focusable: true
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

        // ------------------------------------------- network choice
        // Tailscale stays the recommended path; the home network is offered
        // quietly while Tailscale is missing or signed out, and in home-network
        // mode there is always a way back.
        Text {
          readonly property bool offerLan: !!root.engine && !root.engine.lanMode && root.step.alt !== undefined
          readonly property bool offerTailscale: !!root.engine && root.engine.lanMode
          visible: (offerLan || offerTailscale) && !root.showingQr && root.pairState !== "starting"
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
          width: parent.width
          spacing: 4

          Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: "The firewall is still open to " + (root.engine ? root.engine.checks.openSubnets.join(", ") : "")
              + ". Close it before switching?"
            color: Color.muted
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
            && !root.showingQr && root.pairState !== "starting"
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
          visible: root.engine && root.engine.canCloseFirewall && !root.confirmSwitch && !root.showingQr && root.pairState !== "starting"
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
