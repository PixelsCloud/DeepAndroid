/** ZIP with uncompressed UTF-8 entries, bounded by the export handler. */
export function zipFiles(files: {name: string; data: Uint8Array}[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset=0
  for (const file of files) {
    if (!/^(?:report\.(?:md|csv)|evidence\.json|evidence\/[1-9]\d*\.png)$/.test(file.name)) throw new Error('Invalid archive entry')
    const data=Buffer.from(file.data),name=Buffer.from(file.name,'utf8')
    let crc=0xffffffff
    for (const byte of data) { crc^=byte; for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0) }
    crc=(crc^0xffffffff)>>>0
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26)
    local.writeUInt16LE(33,12)
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42)
    entry.writeUInt16LE(33,14)
    locals.push(local,name,data);central.push(entry,name);offset+=local.length+name.length+data.length
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...locals,directory,end])
}
