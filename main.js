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
    SiteUrl            : 'https://cermesm.alwaysdata.net/home',
    CheckIntervalMs    : 60 * 1000,
    OfflineThresholdMin: 6,
    ReminderIntervalMin: 10,
    AppName            : 'Solar Monitor',
    GithubOwner        : '214B-18EF',
    GithubRepo         : 'sm_desktop',
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

            }
        });
    }).on('error', () => {});
}

  //=========================================================//
 //              VERIFICATION MISES A JOUR APP              //
//=========================================================//
function CheckAppUpdate() {
    const Url      = `api.github.com`;
    const Options  = {
        hostname: 'api.github.com',
        path    : `/repos/${Config.GithubOwner}/${Config.GithubRepo}/releases/latest`,
        method  : 'GET',
        headers : {
            'User-Agent'   : 'Solar-Monitor-Desktop',
            'Authorization': `token ${Config.GithubToken}`
        }
    };

    const Req = Https.request(Options, (Res) => {
        let Raw = '';
        Res.on('data',  Chunk => Raw += Chunk);
        Res.on('end', () => {
            try {
                const Release    = JSON.parse(Raw);
                const Latest     = Release.tag_name?.replace('v', '');
                const Current    = app.getVersion();

                if (!Latest || Latest === Current) return;

                const DownloadUrl = Release.assets?.[0]?.browser_download_url;
                if (!DownloadUrl) return;

                ShowUpdateDialog(Latest, Current, DownloadUrl);

            } catch (Err) {

            }
        });
    });

    Req.on('error', () => {});
    Req.end();
}

function ShowUpdateDialog(Latest, Current, DownloadUrl) {
    const { dialog } = require('electron');

    dialog.showMessageBox({
        type   : 'info',
        title  : 'Mise a jour disponible',
        message: `Une nouvelle version est disponible`,
        detail : `Version actuelle : ${Current}\nNouvelle version : ${Latest}\n\nVoulez-vous telecharger la mise a jour ?`,
        buttons: ['Installer maintenant', 'Plus tard'],
        defaultId: 0,
        cancelId : 1
    }).then(Result => {
        if (Result.response === 0) {
            shell.openExternal(DownloadUrl);
        }
    });
}

  // =========================================================//
 //                          STATE                           //
//=========================================================//

let MainWindow                   = null;
let TrayIcon                     = null;
let PollInterval                 = null;
let LastKnownStatus              = null;
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

    // ========== Gestion pas d'acces internet ==========
    MainWindow.webContents.on('did-fail-load', (Event, ErrorCode) => {
        if (ErrorCode === -106 || ErrorCode === -105 || ErrorCode === -3) {
            setTimeout(() => {
                if (MainWindow && !MainWindow.isDestroyed()) {
                    MainWindow.loadURL(Config.SiteUrl);
                }
            }, 30000);
        }
    });

    MainWindow.once('ready-to-show', () => {
        MainWindow.show();
    });

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

        // ========== Transition online vers offline ==========
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

        // ========== Transition offline vers online ==========
        if (LastKnownStatus === 'offline' && CurrentStatus === 'online') {
            SendNotification(
                'ESP32 De Retour En Ligne',
                'La connexion avec l\'ESP32 a ete retablie.'
            );
            MinutesOfflineAtLastReminder = 0;
        }

        // ========== Premier demarrage, deja offline ==========
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
 //                           IPC                           //
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

    CheckAppUpdate();
    setInterval(CheckAppUpdate, 6 * 60 * 60 * 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            CreateMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
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
