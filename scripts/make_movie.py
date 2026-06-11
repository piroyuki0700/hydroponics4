#!/usr/bin/python3

import glob
import re
import os
import subprocess

outfiles = "/tmp/picture_*.png"
for outfile in  glob.glob(outfiles):
    os.remove(outfile)

infiles = glob.glob("../picture/picture_*.jpg")
infiles.sort()
num = 0
for infile in infiles:
    #print(infile)
    matches = re.match(r'../picture/picture_([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})[0-9]{2}[0-9]{2}.jpg', infile)
    if (matches != None):
        groups = matches.groups()
        #print(groups)
        year = groups[0]
        month = groups[1]
        day = groups[2]
        #hour = int(groups[3])
        text = f'{year}/{month}/{day}'
        #print(text)
        num += 1
        outfile = f'/tmp/picture_{num:04}.png'
        command=f'ffmpeg -i {infile} -filter_complex "drawtext=text=\'{text}\':x=w-text_w-20:y=20:fontcolor=#FFFFFFAA:fontsize=48:box=1:boxcolor=#00000080:boxborderw=5" -y {outfile} > /dev/null 2>&1'
        #print(command)
        print(f"{num:04}: {infile}")
        subprocess.run(command, shell=True)

command=f"ffmpeg -r 20 -i /tmp/picture_%04d.png -pix_fmt yuv420p -y movie_{year}.mp4"
print(command)
subprocess.run(command, shell=True)

#for outfile in  glob.glob(outfiles):
#    os.remove(outfile)



