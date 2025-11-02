Attribute VB_Name = "BTSMenu"
' Excel VBA helper — installs a BTS menu aligned with the automation catalog.

Private Const BTS_MENU_CAPTION As String = "BTS"

Public Sub InstallBtsMenu()
    Dim menuBar As CommandBar
    Dim btsMenu As CommandBarPopup

    On Error Resume Next
    Application.CommandBars("Worksheet Menu Bar").Controls(BTS_MENU_CAPTION).Delete
    On Error GoTo 0

    Set menuBar = Application.CommandBars("Worksheet Menu Bar")
    Set btsMenu = menuBar.Controls.Add(Type:=msoControlPopup, Temporary:=True)
    btsMenu.Caption = BTS_MENU_CAPTION

    AddSectionMenu btsMenu, "02 — Tariff Management", Array()
    AddSectionMenu btsMenu, "03 — Season Management", Array( _
        CreateMenuItem("Send renewal invites (dry-run)", "RunSendRenewInvites") _
    )
    AddSectionMenu btsMenu, "04 — Event Management", Array()
End Sub

Private Function CreateMenuItem(ByVal caption As String, ByVal macroName As String) As Variant
    Dim item(1) As Variant
    item(0) = caption
    item(1) = macroName
    CreateMenuItem = item
End Function

Private Sub AddSectionMenu(ByVal parentMenu As CommandBarPopup, ByVal sectionCaption As String, items As Variant)
    Dim sectionMenu As CommandBarPopup
    Dim i As Long
    Set sectionMenu = parentMenu.Controls.Add(Type:=msoControlPopup)
    sectionMenu.Caption = sectionCaption

    If Not IsEmpty(items) Then
        For i = LBound(items) To UBound(items)
            If Not IsEmpty(items(i)) Then
                With sectionMenu.Controls.Add(Type:=msoControlButton)
                    .Caption = CStr(items(i)(0))
                    .OnAction = "'" & items(i)(1) & "'"
                End With
            End If
        Next i
    End If
End Sub

' Placeholder — wire to the actual automation macro when implemented.
Public Sub RunSendRenewInvites()
    MsgBox "TODO: Implement BTS renewal invite automation for Excel.", vbInformation, "BTS Automation"
End Sub

