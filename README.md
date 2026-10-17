# Rootpilot Snake

Snake wie auf den alten Nokia-Handys: grünes LCD, Pixelgrafik, neun
Geschwindigkeiten, Bildschirmtasten und PC-Pfeiltasten, Retroton und lokaler Highscore.
Eine statische Website ohne Framework, Build oder Serveranwendung.
Die Oberfläche um das Nokia-inspirierte LCD ist neutral und zurückhaltend
gestaltet. Auf dem Handy steht das Spiel vor den Einstellungen.

Starten, Pausieren und erneut Spielen erfolgen über die Bildschirmtasten.
Zum Lenken dienen die Richtungstasten auf dem Bildschirm, auch auf dem Handy,
oder die Pfeiltasten am PC. Wischgesten und weitere Spiel-Tastenkürzel gibt es nicht.

## Direkt in AWS veröffentlichen

Die Website wird unter **https://snake.rootpilot.de** über **S3 und CloudFront**
bereitgestellt. Die Einrichtung erfolgt in **AWS CloudShell**, ohne separaten
Webserver. AWS CLI und Python 3 sind dort bereits vorhanden.

1. AWS CloudShell im gewünschten AWS-Konto öffnen und dieses Projekt dort
   auschecken oder hochladen. `setup.sh`, `infra/` und die Webdateien müssen im
   selben Projektverzeichnis liegen.
2. Im Projektverzeichnis ausführen:

   ```bash
   bash setup.sh
   ```

Wenn du das vorbereitete Archiv `snake-aws.zip` verwendest: über **Actions →
Upload file** in CloudShell hochladen und dann ausführen:

```bash
unzip snake-aws.zip
cd snake
bash setup.sh
```

Das Script nutzt die bestehende AWS-Anmeldung. Es erstellt bzw. aktualisiert:

- ein automatisch DNS-validiertes **ACM-Zertifikat in `us-east-1`**, wie von
  CloudFront benötigt;
- einen **privaten, verschlüsselten S3-Bucket mit Versionierung**, ohne öffentliche
  Bucketfreigabe;
- eine **CloudFront-Distribution**, die über Origin Access Control auf S3
  zugreift, HTTPS erzwingt und Sicherheitsheader setzt;
- die **A- und AAAA-Einträge in Route 53** für `snake.rootpilot.de`;
- die hochgeladenen Webdateien und eine CloudFront-Cache-Aktualisierung.

Zertifikatsprüfung und die globale CloudFront-Bereitstellung können mehrere
Minuten dauern. ACM übernimmt anschließend die Zertifikatserneuerung, solange
der DNS-Validierungseintrag erhalten bleibt. Kein Certbot und kein Cronjob nötig.

Die vorhandene öffentliche Route-53-Zone wird automatisch anhand der Domain
ermittelt. **Sie muss im angemeldeten AWS-Konto liegen und beim Domainanbieter
korrekt delegiert sein.** Eine nur angelegte, nicht autoritative Zone genügt
nicht. Falls mehrere passende Zonen existieren, die richtige explizit angeben:

```bash
bash setup.sh --hosted-zone-id Z123456789
```

Liegt das DNS bislang bei einem anderen Anbieter, muss die gewünschte Zone oder
Subdomain zuerst an Route 53 delegiert werden. Das Script verändert weder die
Registrierung der Domain noch die Nameserver beim Domainanbieter. Andere
DNS-Einträge bleiben bestehen. Eine bereits anderweitig belegte Zieladresse muss
vor einer Umstellung geprüft werden; das Script übernimmt keine fremden Stacks.

Das angemeldete Konto bzw. die Rolle benötigt Zugriff auf **CloudFormation,
ACM, S3, CloudFront und Route 53** für die betreffenden Ressourcen. AWS-Zugangs-
schlüssel gehören nicht in dieses Repository. Die CloudShell-Anmeldung oder ein
bereits eingerichtetes AWS-Profil reicht aus.

## Optionen und Aktualisierungen

```bash
# S3 in Frankfurt; das CloudFront-Zertifikat bleibt in us-east-1:
bash setup.sh --region eu-central-1

# Ein bereits eingerichtetes AWS-Profil verwenden:
bash setup.sh --profile mein-profil

# Eine andere Domain in einer passenden öffentlichen Route-53-Zone:
bash setup.sh --domain snake.example.de --hosted-zone-id Z123456789
```

Ohne `--region` wird `AWS_REGION` bzw. `AWS_DEFAULT_REGION` verwendet, andernfalls
`eu-central-1`. CloudFront verteilt die Website weltweit. Der Standardpräfix der
CloudFormation-Stacks ist `rootpilot-snake-rootpilot-de`; mit `--stack-prefix`
lässt er sich explizit setzen. Für Updates dieselbe Domain, Region und denselben
Präfix verwenden und **`bash setup.sh` erneut ausführen**. Bestehende Stacks
werden aktualisiert; ein unveränderter Stack gilt als erfolgreicher Aufruf.

Es werden ausschließlich diese vier Dateien veröffentlicht:

```text
assets/game.js
assets/favicon.svg
styles.css
index.html
```

HTML wird zuletzt übertragen. Alle unversionierten Dateien werden vor erneuter
Verwendung revalidiert; nach dem Upload leert das Script den CloudFront-Cache.
Es gibt keinen destruktiven `s3 sync --delete`-Schritt. S3-Versionierung bewahrt
frühere Dateiversionen. Der Bucket bleibt auch beim Löschen des Hosting-Stacks
erhalten, einschließlich seines Inhalts.

Bei einem Fehler stoppt das Script mit dem betroffenen Schritt und den
Stacknamen. Ressourcen werden nicht automatisch gelöscht. Details stehen in
den CloudFormation-Ereignissen. Einen Stack im Zustand `ROLLBACK_COMPLETE`
zuerst dort prüfen und gegebenenfalls den fehlgeschlagenen Stack entfernen,
bevor derselbe Aufruf erneut gestartet wird.

## Dateien und Branding

- `index.html` und `styles.css`: zurückhaltende Oberfläche mit Nokia-inspiriertem LCD.
- `assets/game.js`: Spiellogik ohne externe Bibliotheken.
- `infra/certificate.yaml`: ACM-Zertifikat und DNS-Validierung.
- `infra/hosting.yaml`: S3, CloudFront, Sicherheitsheader und Domain.
- `setup.sh`: gesamtes AWS-Deployment aus der CloudShell.

Der Kopfbereich greift die übermittelte Logo-Vorlage typografisch auf: dunkler
Schriftzug `rootpilot`, türkiser Unterstrich und der Claim „Beyond technology.“.
Die originale Bild-/Vektordatei liegt noch nicht vor; die Darstellung ist deshalb
als Text und CSS umgesetzt. Ein dezenter Hinweis verweist auf die Rootpilot-Website.
Externe Werbenetzwerke und Tracking sind nicht eingebunden. Highscore und
Spieleinstellungen werden im Browser gespeichert.

Auf Wunsch wurden bei der Erstellung keine lokalen Tests, Syntaxprüfungen oder
Serverstarts ausgeführt. AWS-Ressourcen wurden aus dieser Arbeitsumgebung noch
nicht angelegt; eine nutzbare AWS-Anmeldung ist hier nicht hinterlegt.
