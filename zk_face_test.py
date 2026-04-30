#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Herramienta CLI para registrar usuario y rostro en dispositivo ZKTeco vía SDK.
Uso: python zk_face_cli.py --ip 192.168.2.200 --pin 10 --nombre "Juan Perez" --foto ruta/a/foto.jpg
"""

import sys
import argparse
import pythoncom
from win32com.client import Dispatch

def conectar_dispositivo(ip, puerto=4370):
    zk = Dispatch("zkemkeeper.ZKEM.1")
    pythoncom.CoInitialize()
    print(f"🔌 Conectando a {ip}:{puerto}...")
    if zk.Connect_Net(ip, puerto):
        print("✅ Conectado")
        return zk
    else:
        print("❌ No se pudo conectar")
        return None

def crear_usuario(zk, pin, nombre):
    # Parámetros: privilege (1=usuario normal), pin, name, password, group, enabled
    zk.SSR_SetUserInfo(1, pin, nombre, "", 0, True)
    print(f"✅ Usuario {nombre} (PIN {pin}) creado en el dispositivo")

def registrar_rostro(zk, pin, ruta_foto):
    # Leer la imagen JPG como bytes
    try:
        with open(ruta_foto, "rb") as f:
            foto_bytes = f.read()
    except Exception as e:
        print(f"❌ Error leyendo la foto: {e}")
        return False

    # Intentar registrar rostro
    # El método SetUserFace espera: PIN, nombre (opcional), datos de la imagen? 
    # La documentación varía. Probamos con la firma común: SetUserFace(pin, image_data)
    # Si falla, probamos con SetUserFace(pin, nombre, image_data)
    try:
        # Versión 1: solo PIN y datos
        resultado = zk.SetUserFace(pin, foto_bytes)
        print(f"Resultado SetUserFace (versión 1): {resultado}")
        if resultado:
            return True
    except Exception as e:
        print(f"Error con versión 1: {e}")

    try:
        # Versión 2: con nombre
        resultado = zk.SetUserFace(pin, "", foto_bytes)
        print(f"Resultado SetUserFace (versión 2): {resultado}")
        return resultado
    except Exception as e:
        print(f"Error con versión 2: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Registrar usuario y rostro en ZKTeco")
    parser.add_argument("--ip", required=True, help="IP del dispositivo")
    parser.add_argument("--puerto", type=int, default=4370, help="Puerto (default 4370)")
    parser.add_argument("--pin", required=True, help="Número de identificación (PIN)")
    parser.add_argument("--nombre", required=True, help="Nombre del usuario")
    parser.add_argument("--foto", required=True, help="Ruta a la imagen JPG")
    args = parser.parse_args()

    zk = conectar_dispositivo(args.ip, args.puerto)
    if not zk:
        sys.exit(1)

    crear_usuario(zk, args.pin, args.nombre)

    if registrar_rostro(zk, args.pin, args.foto):
        print("✅ Rostro registrado exitosamente")
    else:
        print("❌ No se pudo registrar el rostro. El dispositivo puede no soportar esta función.")
        print("   Alternativa: registra el rostro manualmente en el dispositivo y luego sincroniza.")

    # Liberar recursos
    zk = None
    pythoncom.CoUninitialize()

if __name__ == "__main__":
    main()