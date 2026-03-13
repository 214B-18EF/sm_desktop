// =========================================================//
//                   SOLAR MONITOR DESKTOP                  //
//                         main.js                          //
//=========================================================//

const { 
    app, 
    BrowserWindow, 
    Tray, 
    Menu, 
    nativeImage,
    Notification,
    shell,
    ipcMain
} = require('electron');

const Path  = require('path');
const Https = require('https');
const Http  = require('http');


//=========================================================//
//              INSTANCE UNIQUE DE L'APPLICATION           //
//=========================================================//
const GotLock = app.requestSingleInstanceLock();

if (!GotLock) {
    app.quit();
}
else {
    app.on('second-instance', () => {
        if (MainWindow) {
            if (MainWindow.isMinimized()) MainWindow.restore();
            MainWindow.show();
            MainWindow.focus();
        }
    });
}

// =========================================================//
//                      CONFIGURATION                       //
//=========================================================//

const Config = {
    ApiBaseUrl         : 'https://cermesm.alwaysdata.net/api',
    SiteUrl            : 'https://cermesm.alwaysdata.net',
    CheckIntervalMs    : 60 * 1000,
    OfflineThresholdMin: 6,
    ReminderIntervalMin: 10,
    AppName            : 'Solar Monitor',
    Window: {
        Width    : 1350,
        Height   : 800,
        MinWidth : 1280,
        MinHeight: 720
    }
};

//=========================================================//
//              VERIFICATION VERSION SITE                  //
//=========================================================//
let CurrentSiteVersion = null;

function CheckSiteVersion() {
    const Url      = Config.SiteUrl + '/version.json';
    const Protocol = Url.startsWith('https') ? Https : Http;

    Protocol.get(Url, { timeout: 5000 }, (Res) => {
        let Raw = '';
        Res.on('data',  Chunk => Raw += Chunk);
        Res.on('end', () => {
            try {
                const Data    = JSON.parse(Raw);
                const Version = Data.version;

                if (CurrentSiteVersion === null) {
                    CurrentSiteVersion = Version;
                }
                else if (Version !== CurrentSiteVersion) {
                    CurrentSiteVersion = Version;
                    if (MainWindow && !MainWindow.isDestroyed()) {
                        MainWindow.webContents.reloadIgnoringCache();
                    }
                }
            } catch (Err) {
                // Silencieux
            }
        });
    }).on('error', () => {});
}

// =========================================================//
//                          STATE                           //
//=========================================================//

let MainWindow                   = null;
let TrayIcon                     = null;
let PollInterval                 = null;
let LastKnownStatus              = null;   // null | 'online' | 'offline'
let MinutesOfflineAtLastReminder = 0;
let IsQuitting                   = false;

// =========================================================//
//                      GESTION ICONES                      //
//=========================================================//

function GetTrayIcon(Status) {
    const IconMap = {
        online : 'icon-online.png',
        offline: 'icon-offline.png',
        default: 'icon.png'
    };

    const IconFile = IconMap[Status] || IconMap.default;
    const IconPath = Path.join(__dirname, 'assets', IconFile);

    try {
        const Img = nativeImage.createFromPath(IconPath);
        if (!Img.isEmpty()) return Img;
    } catch (Err) {
        // Silencieux - retombe sur l'icone par defaut
    }

    return nativeImage.createFromPath(Path.join(__dirname, 'assets', 'icon.png'));
}

// =========================================================//
//                    FENETRE PRINCIPALE                    //
//=========================================================//

function CreateMainWindow() {
    MainWindow = new BrowserWindow({
        width          : Config.Window.Width,
        height         : Config.Window.Height,
        minWidth       : Config.Window.MinWidth,
        minHeight      : Config.Window.MinHeight,
        title          : Config.AppName,
        icon           : Path.join(__dirname, 'assets', 'icon.png'),
        autoHideMenuBar: true,
        show           : false,
        webPreferences : {
            nodeIntegration : false,
            contextIsolation: true,
            preload         : Path.join(__dirname, 'preload.js'),
            backgroundThrottling: false,
            spellcheck          : false
        }
    });

    MainWindow.loadURL(Config.SiteUrl);

    // ========== Detection connexion internet ==========
    MainWindow.webContents.on('did-fail-load', (Event, ErrorCode, ErrorDescription) => {
        if (ErrorCode === -106 || ErrorCode === -105 || ErrorCode === -3) {
            MainWindow.webContents.loadURL(`data:text/html;charset=utf-8,
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                        font-family: 'Segoe UI', sans-serif;
                        display: flex; flex-direction: column;
                        align-items: center; justify-content: center;
                        height: 100vh;
                        background: #f0f4f8;
                        color: #333;
                    }
                    .Icon    { font-size: 64px; margin-bottom: 20px; }
                    h2       { font-size: 22px; margin-bottom: 10px; color: #c0392b; }
                    p        { color: #666; margin-bottom: 30px; text-align: center; }
                    .Spinner {
                        width: 40px; height: 40px;
                        border: 4px solid #ddd;
                        border-top: 4px solid #00a8e7;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin-bottom: 15px;
                    }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    small { color: #aaa; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="Icon">&#x26A0;</div>
                <h2>Pas de connexion internet</h2>
                <p>Solar Monitor va se reconnecter automatiquement<br>des que le reseau sera disponible.</p>
                <div class="Spinner"></div>
                <small>Reconnexion en cours...</small>
                <script>
                    window.addEventListener('online', () => {
                        window.location.href = 'https://cermesm.alwaysdata.net';
                    });
                </script>
            </body>
            </html>`);
        }
    });

    MainWindow.once('ready-to-show', () => {
        MainWindow.show();
    });

    // Fermer la fenetre -> reduire dans la tray, ne pas quitter
    let TrayNotifShown = false;

    MainWindow.on('close', (Event) => {

        if (IsQuitting) return;

        Event.preventDefault();
        MainWindow.hide();

        if (!TrayNotifShown) {
            TrayIcon.displayBalloon({
                title  : 'SolarMonitoring',
                content: 'continue de fonctionner en arrière plan, cliquer sur l\'icone dans la barre des tâches pour l\'ouvrir'
            });
            TrayNotifShown = true;
        }
    });

    MainWindow.on('closed', () => {
        MainWindow = null;
    });

    // Ouvrir les liens externes dans le navigateur systeme
    MainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(Config.SiteUrl)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
}

// =========================================================//
//                       SYSTEM TRAY                        //
//=========================================================//

function CreateTray() {
    TrayIcon = new Tray(GetTrayIcon('default'));
    TrayIcon.setToolTip(Config.AppName);

    UpdateTrayMenu(null);

    TrayIcon.on('double-click', () => {
        ShowMainWindow();
    });
}

function UpdateTrayMenu(Status) {
    const StatusLabels = {
        online : 'ESP32 - En ligne',
        offline: 'ESP32 - Hors ligne',
        default: 'ESP32 - Statut inconnu'
    };

    const StatusLabel = StatusLabels[Status] || StatusLabels.default;

    const ContextMenu = Menu.buildFromTemplate([
        {
            label  : Config.AppName,
            enabled: false
        },
        { type: 'separator' },
        {
            label  : StatusLabel,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Tableau de bord',
            click: () => ShowMainWindow()
        },
        {
            label: 'Actualiser',
            click: () => {
                if (MainWindow && !MainWindow.isDestroyed()) {
                    MainWindow.webContents.reloadIgnoringCache();
                }
            }
        },
        {
            label: 'Verifier status ESP32',
            click: () => CheckEsp32Status()
        },
        { type: 'separator' },
        {
            label: 'Quitter',
            click: () => {
                IsQuitting = true;
                app.quit();
            }
        }
    ]);

    TrayIcon.setContextMenu(ContextMenu);

    const Icon = GetTrayIcon(Status);
    if (!Icon.isEmpty()) {
        TrayIcon.setImage(Icon);
    }
}

function ShowMainWindow() {
    if (MainWindow) {
        if (MainWindow.isMinimized()) MainWindow.restore();
        MainWindow.show();
        MainWindow.focus();
    } else {
        CreateMainWindow();
    }
}

// =========================================================//
//                      NOTIFICATIONS                       //
//=========================================================//

function SendNotification(Title, Body) {
    if (!Notification.isSupported()) return;

    const Notif = new Notification({
        title      : Title,
        body       : Body,
        icon       : Path.join(__dirname, 'assets', 'icon.png'),
        timeoutType: 'default',
        appName    : Config.AppName
    });

    Notif.on('click', () => {
        ShowMainWindow();
    });

    Notif.show();
}

function ShowTrayBalloon(Title, Content) {
    if (TrayIcon && process.platform === 'win32') {
        try {
            TrayIcon.displayBalloon({
                title   : Title,
                content : Content,
                iconType: 'info'
            });
        } catch (Err) {
            // Non supporte sur certaines versions Windows
        }
    }
}

// =========================================================//
//                        APPEL API                         //
//=========================================================//

function FetchEsp32Status() {
    return new Promise((Resolve, Reject) => {
        const Url      = Config.ApiBaseUrl + '/esp32/status';
        const Protocol = Url.startsWith('https') ? Https : Http;

        const Req = Protocol.get(Url, { timeout: 10000 }, (Res) => {
            let RawData = '';
            Res.on('data',  Chunk => RawData += Chunk);
            Res.on('end', () => {
                try {
                    Resolve(JSON.parse(RawData));
                } catch (Err) {
                    Reject(new Error('Reponse API invalide'));
                }
            });
        });

        Req.on('error', Reject);
        Req.on('timeout', () => {
            Req.destroy();
            Reject(new Error('Timeout API'));
        });
    });
}

// =========================================================//
//                   VERIFICATION ESP32                     //
//=========================================================//

async function CheckEsp32Status() {
    try {
        const Response = await FetchEsp32Status();

        if (!Response || !Response.success) return;

        const Esp32          = Response.esp32;
        const IsOnline       = Esp32?.isOnline === true;
        const MinutesOffline = Esp32?.minutesSinceLastHeartbeat || 0;
        const CurrentStatus  = IsOnline ? 'online' : 'offline';

        // ========== Transition online -> offline ==========
        if (LastKnownStatus === 'online' && CurrentStatus === 'offline') {
            SendNotification(
                'ESP32 Hors Ligne',
                'Aucun signal recu depuis ' + MinutesOffline + ' min. Verifiez la connexion.'
            );
            MinutesOfflineAtLastReminder = MinutesOffline;
        }

        // ========== Rappel periodique si toujours offline ==========
        if (LastKnownStatus === 'offline' && CurrentStatus === 'offline') {
            const MinutesSinceLastReminder = MinutesOffline - MinutesOfflineAtLastReminder;
            if (MinutesSinceLastReminder >= Config.ReminderIntervalMin) {
                SendNotification(
                    'ESP32 Toujours Hors Ligne',
                    'Aucun signal depuis ' + MinutesOffline + ' minutes.'
                );
                MinutesOfflineAtLastReminder = MinutesOffline;
            }
        }

        // ========== Transition offline -> online ==========
        if (LastKnownStatus === 'offline' && CurrentStatus === 'online') {
            SendNotification(
                'ESP32 De Retour En Ligne',
                'La connexion avec l\'ESP32 a ete retablie.'
            );
            MinutesOfflineAtLastReminder = 0;
        }

        // ========== Premier demarrage - deja offline ==========
        if (LastKnownStatus === null && CurrentStatus === 'offline') {
            SendNotification(
                'ESP32 Hors Ligne',
                'L\'ESP32 est hors ligne depuis ' + MinutesOffline + ' min.'
            );
            MinutesOfflineAtLastReminder = MinutesOffline;
        }

        // ========== Mise a jour state et tray ==========
        LastKnownStatus = CurrentStatus;
        UpdateTrayMenu(CurrentStatus);

        // ========== Notifier la fenetre si elle est ouverte ==========
        if (MainWindow && !MainWindow.isDestroyed()) {
            MainWindow.webContents.send('Esp32StatusUpdate', {
                IsOnline      : IsOnline,
                MinutesOffline: MinutesOffline,
                LastHeartbeat : Esp32?.lastHeartbeat
            });
        }

    } catch (Err) {
        // Erreur reseau silencieuse - on ne change pas le statut connu
    }
}

// =========================================================//
//                         POLLING                          //
//=========================================================//

function StartPolling() {
    CheckEsp32Status();
    PollInterval = setInterval(CheckEsp32Status, Config.CheckIntervalMs);
}

function StopPolling() {
    if (PollInterval) {
        clearInterval(PollInterval);
        PollInterval = null;
    }
}

// =========================================================//
//                      IPC HANDLERS                        //
//=========================================================//

ipcMain.handle('GetEsp32Status', async () => {
    try {
        return await FetchEsp32Status();
    } catch (Err) {
        return { success: false, error: Err.message };
    }
});

ipcMain.handle('GetLastStatus', () => {
    return { Status: LastKnownStatus };
});

// =========================================================//
//                     EVENEMENTS APP                       //
//=========================================================//

app.whenReady().then(() => {
    CreateMainWindow();
    CreateTray();
    StartPolling();

    CheckSiteVersion();
    setInterval(CheckSiteVersion, 30 * 60 * 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            CreateMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Windows / Linux : rester dans la tray
    // macOS : quitter normalement
    if (process.platform === 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    IsQuitting = true;
    StopPolling();
});

// =========================================================//
//                   DEMARRAGE AUTOMATIQUE                  //
//=========================================================//

if (app.isPackaged) {
    app.setLoginItemSettings({
        openAtLogin: true,
        name       : Config.AppName,
        args       : ['--hidden']
    });
}
