const PROTO_PATH = __dirname + '/../service.proto'

import * as grpc from 'grpc'
import * as protoLoader from '@grpc/proto-loader'
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})
const { blog } = grpc.loadPackageDefinition(packageDefinition) as any

function main() {
  const client = new blog.Blog(
    'localhost:50051',
    grpc.credentials.createInsecure(),
  )

  // Create new user
  const data = {
    title: 'Hello World',
    content: '',
    authorEmail: 'alice@prisma.io',
  }
  client.signupUser(data, (err: any, response: any) => {
    if (err) {
      console.error(err)
      return
    }
    console.log(response)
  })
}

main()
