import pythoncom
from win32com.client import Dispatch

pythoncom.CoInitialize()

zk = Dispatch("zkemkeeper.ZKEM.1")

IP = "TU_IP"
PUERTO = 4370

if zk.Connect_Net(IP, PUERTO):
    print("✅ Conectado")

    pin = "1"
    nombre = "Test"

    # Crear usuario
    zk.SSR_SetUserInfo(1, pin, nombre, "", 0, True)

    # Intentar enviar rostro (vacío solo para probar función)
    result = zk.SetUserFace(pin, nombre, "")

    print("Resultado:", result)
else:
    print("❌ No conecta")