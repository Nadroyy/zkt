# Endpoints ZKTeco TCP

## Variables sugeridas en Postman

- `baseUrl`: `http://localhost:3000`
- `zkIp`: `192.168.1.201`

## Probar conectividad TCP

### `GET {{baseUrl}}/zk/ping?ip={{zkIp}}`

Respuesta esperada:

```json
{
  "ok": true,
  "type": "tcp",
  "ip": "192.168.1.201",
  "port": 4370,
  "responseTimeMs": 16.73,
  "timestamp": "2026-04-20T18:00:00.000Z",
  "message": "Puerto TCP 4370 accesible"
}
```

## Validar handshake con pyzk

### `GET {{baseUrl}}/zk/test-connection?ip={{zkIp}}`

## Obtener informacion del equipo

### `GET {{baseUrl}}/zk/device-info?ip={{zkIp}}`

## Listar usuarios

### `GET {{baseUrl}}/zk/users?ip={{zkIp}}`

## Crear o actualizar usuario

### `POST {{baseUrl}}/zk/create-user`

```json
{
  "ip": "192.168.1.201",
  "uid": "10",
  "userId": "10",
  "name": "Juan Perez",
  "password": "1234",
  "role": 0
}
```

## Actualizar nombre o password

### `POST {{baseUrl}}/zk/update-user`

```json
{
  "ip": "192.168.1.201",
  "uid": "10",
  "userId": "10",
  "name": "Juan Perez Actualizado",
  "password": "4321"
}
```

## Eliminar usuario

### `DELETE {{baseUrl}}/zk/user/10?ip={{zkIp}}`

## Ver logs recientes

### `GET {{baseUrl}}/zk/logs`
